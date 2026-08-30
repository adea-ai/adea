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
    Complete { text: String },
    Error { code: &'static str },
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

    const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(120);
    const SESSION_TIMEOUT: Duration = Duration::from_secs(90);

    fn microphone_authorized() -> bool {
        let media_type = unsafe { AVMediaTypeAudio };
        let Some(media_type) = media_type else {
            return false;
        };
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
        if status == AVAuthorizationStatus::Authorized {
            return true;
        }
        if status != AVAuthorizationStatus::NotDetermined {
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
        let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
        if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
            return true;
        }
        if status != SFSpeechRecognizerAuthorizationStatus::NotDetermined {
            return false;
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
