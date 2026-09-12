use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, State};

#[derive(Default)]
pub struct DesktopTranscriptionState {
    sessions: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TranscriptionEvent {
    /// Part of the event contract with the packaged client on every platform.
    /// Only the macOS recognizer constructs it; other platforms report
    /// `Error { code: "unavailable" }` instead, which is why the variant is
    /// dead code there and must not fail the lint on those targets.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Complete {
        text: String,
    },
    Error {
        code: &'static str,
    },
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::{rc::autoreleasepool, runtime::Bool, AnyThread};
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer};
    use objc2_foundation::{NSLocale, NSString};
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognizer,
        SFSpeechRecognizerAuthorizationStatus,
    };
    use std::{
        ptr::NonNull,
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    /// What the host reported for one permission.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Authorization {
        Denied,
        Granted,
        Undetermined,
    }

    const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(120);
    const SESSION_TIMEOUT: Duration = Duration::from_secs(90);

    /// What the host currently says, without asking the user anything.
    fn authorization(state: AVAuthorizationStatus) -> Authorization {
        match state {
            AVAuthorizationStatus::Authorized => Authorization::Granted,
            AVAuthorizationStatus::NotDetermined => Authorization::Undetermined,
            _ => Authorization::Denied,
        }
    }

    fn microphone_status() -> Authorization {
        let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
            return Authorization::Denied;
        };
        authorization(unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) })
    }

    fn speech_status() -> Authorization {
        match unsafe { SFSpeechRecognizer::authorizationStatus() } {
            SFSpeechRecognizerAuthorizationStatus::Authorized => Authorization::Granted,
            SFSpeechRecognizerAuthorizationStatus::NotDetermined => Authorization::Undetermined,
            _ => Authorization::Denied,
        }
    }

    /// Report the host's answer for both permissions without prompting; this is
    /// what the capability snapshot reads.
    pub fn permission_state() -> &'static str {
        match (microphone_status(), speech_status()) {
            (Authorization::Granted, Authorization::Granted) => "granted",
            (Authorization::Denied, _) | (_, Authorization::Denied) => "denied",
            _ => "prompt",
        }
    }

    fn microphone_authorized() -> bool {
        let media_type = unsafe { AVMediaTypeAudio };
        let Some(media_type) = media_type else {
            return false;
        };
        if microphone_status() == Authorization::Granted {
            return true;
        }
        if microphone_status() == Authorization::Denied {
            return false;
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = sender.send(granted.as_bool());
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler)
        };
        receiver
            .recv_timeout(AUTHORIZATION_TIMEOUT)
            .unwrap_or(false)
    }

    fn speech_authorized() -> bool {
        match speech_status() {
            Authorization::Granted => return true,
            Authorization::Denied => return false,
            Authorization::Undetermined => {}
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
            let _ = sender.send(status == SFSpeechRecognizerAuthorizationStatus::Authorized);
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
        receiver
            .recv_timeout(AUTHORIZATION_TIMEOUT)
            .unwrap_or(false)
    }

    pub fn request_permission() -> &'static str {
        autoreleasepool(|_| {
            if microphone_authorized() && speech_authorized() {
                "granted"
            } else {
                "denied"
            }
        })
    }

    fn run_session(
        locale: String,
        cancelled: Arc<AtomicBool>,
        events: Channel<TranscriptionEvent>,
    ) {
        autoreleasepool(|_| unsafe {
            let locale_identifier = NSString::from_str(&locale);
            let locale = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &locale_identifier);
            let Some(recognizer) =
                SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale)
            else {
                let _ = events.send(TranscriptionEvent::Error {
                    code: "unsupportedLocale",
                });
                return;
            };
            if !recognizer.isAvailable() {
                let _ = events.send(TranscriptionEvent::Error {
                    code: "unavailable",
                });
                return;
            }

            let request = SFSpeechAudioBufferRecognitionRequest::new();
            request.setShouldReportPartialResults(false);
            if recognizer.supportsOnDeviceRecognition() {
                request.setRequiresOnDeviceRecognition(true);
            }

            let engine = AVAudioEngine::new();
            let input = engine.inputNode();
            let format = input.outputFormatForBus(0);
            let request_for_tap = request.clone();
            let tap = RcBlock::new(
                move |buffer: NonNull<AVAudioPCMBuffer>,
                      _when: NonNull<objc2_avf_audio::AVAudioTime>| {
                    request_for_tap.appendAudioPCMBuffer(buffer.as_ref());
                },
            );
            input.installTapOnBus_bufferSize_format_block(
                0,
                1_024,
                Some(&format),
                RcBlock::as_ptr(&tap),
            );

            let (result_sender, result_receiver) = mpsc::channel::<Result<String, ()>>();
            let result_handler = RcBlock::new(
                move |result: *mut SFSpeechRecognitionResult,
                      error: *mut objc2_foundation::NSError| {
                    if !error.is_null() {
                        let _ = result_sender.send(Err(()));
                        return;
                    }
                    let Some(result) = result.as_ref() else {
                        return;
                    };
                    if result.isFinal() {
                        let text = result.bestTranscription().formattedString().to_string();
                        let _ = result_sender.send(Ok(text));
                    }
                },
            );
            let task =
                recognizer.recognitionTaskWithRequest_resultHandler(&request, &result_handler);
            engine.prepare();
            if engine.startAndReturnError().is_err() {
                input.removeTapOnBus(0);
                task.cancel();
                let _ = events.send(TranscriptionEvent::Error { code: "audioInput" });
                return;
            }

            let started = Instant::now();
            let outcome = loop {
                if cancelled.load(Ordering::Acquire) {
                    break None;
                }
                match result_receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(result) => break Some(result),
                    Err(mpsc::RecvTimeoutError::Disconnected) => break Some(Err(())),
                    Err(mpsc::RecvTimeoutError::Timeout)
                        if started.elapsed() >= SESSION_TIMEOUT =>
                    {
                        break Some(Err(()));
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            };

            engine.stop();
            input.removeTapOnBus(0);
            request.endAudio();
            if outcome.is_none() {
                task.cancel();
                return;
            }
            task.finish();
            match outcome.expect("checked above") {
                Ok(text) if !text.trim().is_empty() => {
                    let _ = events.send(TranscriptionEvent::Complete {
                        text: text.trim().to_owned(),
                    });
                }
                _ => {
                    let _ = events.send(TranscriptionEvent::Error {
                        code: "recognitionFailed",
                    });
                }
            }
        });
    }

    pub fn start(
        locale: String,
        cancelled: Arc<AtomicBool>,
        events: Channel<TranscriptionEvent>,
        finished: impl FnOnce() + Send + 'static,
    ) {
        thread::spawn(move || {
            run_session(locale, cancelled, events);
            finished();
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn request_permission() -> &'static str {
        "unavailable"
    }

    pub fn permission_state() -> &'static str {
        "unavailable"
    }

    pub fn start(
        _locale: String,
        _cancelled: Arc<AtomicBool>,
        events: Channel<TranscriptionEvent>,
        finished: impl FnOnce() + Send + 'static,
    ) {
        let _ = events.send(TranscriptionEvent::Error {
            code: "unavailable",
        });
        finished();
    }
}

/// The host's answer for the dictation permissions, without prompting. The
/// capability snapshot reads this; the command below asks when it must.
pub fn permission_state() -> &'static str {
    platform::permission_state()
}

#[tauri::command]
pub async fn desktop_transcription_permission() -> Result<&'static str, String> {
    tauri::async_runtime::spawn_blocking(platform::request_permission)
        .await
        .map_err(|_| "System dictation permission check failed".to_owned())
}

#[tauri::command]
pub fn desktop_transcription_start(
    locale: String,
    events: Channel<TranscriptionEvent>,
    state: State<'_, DesktopTranscriptionState>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .sessions
        .lock()
        .map_err(|_| "System dictation state is unavailable".to_owned())?
        .insert(id.clone(), cancelled.clone());
    let sessions = state.sessions.clone();
    let completed_id = id.clone();
    platform::start(locale, cancelled, events, move || {
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&completed_id);
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn desktop_transcription_cancel(
    session_id: String,
    state: State<'_, DesktopTranscriptionState>,
) -> Result<(), String> {
    if let Some(cancelled) = state
        .sessions
        .lock()
        .map_err(|_| "System dictation state is unavailable".to_owned())?
        .remove(&session_id)
    {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_flag_is_idempotent() {
        let flag = Arc::new(AtomicBool::new(false));
        flag.store(true, Ordering::Release);
        flag.store(true, Ordering::Release);
        assert!(flag.load(Ordering::Acquire));
    }

    #[test]
    fn transcription_events_do_not_serialize_audio() {
        let event = TranscriptionEvent::Complete {
            text: "editable text".to_owned(),
        };
        let serialized = serde_json::to_string(&event).expect("event serializes");
        assert_eq!(serialized, r#"{"type":"complete","text":"editable text"}"#);
        assert!(!serialized.contains("audio"));
    }
}
