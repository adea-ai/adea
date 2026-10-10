ALTER TABLE "app"."lead_turn_intents" ADD COLUMN "requested_model_selections" jsonb;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_requested_models_valid" CHECK ("app"."lead_turn_intents"."requested_model_selections" is null or (
        jsonb_typeof("app"."lead_turn_intents"."requested_model_selections") = 'object'
        and "app"."lead_turn_intents"."requested_model_selections" <> '{}'::jsonb
        and ("app"."lead_turn_intents"."requested_model_selections" - 'lead' - 'child') = '{}'::jsonb
        and (not ("app"."lead_turn_intents"."requested_model_selections" ? 'lead') or (
            jsonb_typeof("app"."lead_turn_intents"."requested_model_selections"->'lead') = 'object'
            and "app"."lead_turn_intents"."requested_model_selections"->'lead' ? 'selectionRef' and "app"."lead_turn_intents"."requested_model_selections"->'lead' ? 'selectionRevision'
            and (("app"."lead_turn_intents"."requested_model_selections"->'lead') - 'selectionRef' - 'selectionRevision') = '{}'::jsonb
            and jsonb_typeof("app"."lead_turn_intents"."requested_model_selections"->'lead'->'selectionRef') = 'string'
            and "app"."lead_turn_intents"."requested_model_selections"->'lead'->>'selectionRef' ~ '^msel_[a-f0-9]{32}$'
            and jsonb_typeof("app"."lead_turn_intents"."requested_model_selections"->'lead'->'selectionRevision') = 'number'
            and "app"."lead_turn_intents"."requested_model_selections"->'lead'->>'selectionRevision' ~ '^[0-9]+$'
            and ("app"."lead_turn_intents"."requested_model_selections"->'lead'->>'selectionRevision')::numeric between 1 and 9007199254740991
          )) and (not ("app"."lead_turn_intents"."requested_model_selections" ? 'child') or (
            jsonb_typeof("app"."lead_turn_intents"."requested_model_selections"->'child') = 'object'
            and "app"."lead_turn_intents"."requested_model_selections"->'child' ? 'selectionRef' and "app"."lead_turn_intents"."requested_model_selections"->'child' ? 'selectionRevision'
            and (("app"."lead_turn_intents"."requested_model_selections"->'child') - 'selectionRef' - 'selectionRevision') = '{}'::jsonb
            and jsonb_typeof("app"."lead_turn_intents"."requested_model_selections"->'child'->'selectionRef') = 'string'
            and "app"."lead_turn_intents"."requested_model_selections"->'child'->>'selectionRef' ~ '^msel_[a-f0-9]{32}$'
            and jsonb_typeof("app"."lead_turn_intents"."requested_model_selections"->'child'->'selectionRevision') = 'number'
            and "app"."lead_turn_intents"."requested_model_selections"->'child'->>'selectionRevision' ~ '^[0-9]+$'
            and ("app"."lead_turn_intents"."requested_model_selections"->'child'->>'selectionRevision')::numeric between 1 and 9007199254740991
          ))
      ));
