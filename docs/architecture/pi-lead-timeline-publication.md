# Lead timeline SDK response boundary

The configured lead product invokes the installed SDK, whose methods return complete success envelopes. Dispatch, status, progress and cancel runtime transports consume only the strictly SDK-validated `data` with `schemaVersion: pi-lead-dispatch/v1`. Preparation and lookup retain their existing full-envelope decoders. Funding and current publication retain their separate pinned responses.

Without this projection, a valid dispatch response fails runtime binding validation and leaves the canonical intent `dispatch_pending`; a completed status never reaches timeline publication. The production composition now performs this projection without adding a raw HTTP fallback or accepting caller execution authority.

The completion path retains original actor, execution, attempt, session, selection and preparation pins. It checks the exact UTF-8 result digest through current CP publication authority under Adea's canonical publication locks, then commits one message and receipt. Denied authority or changed pins withhold output; status retry does not dispatch again. CP publication authority must remain lock-safe and never call Adea's private product reader while Adea holds these locks.

Focused tests exercise the real Adea composition and runtime using an explicitly mocked CP transport and an in-memory store. The separate restricted PostgreSQL fixture exercises the real product/repository timeline append using that same mocked CP transport. Neither proves the released SDK, CP production authority, model inference, provider credentials, device authority or deployment. Actual #996 public packages and independently authorized operator configuration remain required; missing configuration or installed SDK support continues to fail closed.

The frozen #1202 disclosure/role fixes and its prior failures remain separate evidence. No migration, credential, grant, screenshot or UI baseline change is part of this slice.

Trusted terminal publication uses a server-only message write boundary that preserves the exact authorized UTF-8 text in both the canonical body and creation identity. Ordinary user message creation retains its existing trim normalization. Leading indentation and trailing whitespace are part of the accepted output; changed text on replay is rejected.
