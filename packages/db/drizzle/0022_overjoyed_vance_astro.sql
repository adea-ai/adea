ALTER TABLE "app"."content_replicas" DROP CONSTRAINT "content_replicas_content_ref_id_content_refs_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."content_refs" ADD CONSTRAINT "content_refs_workspace_id_unique" UNIQUE("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "app"."content_replicas" ADD CONSTRAINT "content_replicas_workspace_content_ref_fk" FOREIGN KEY ("workspace_id","content_ref_id") REFERENCES "app"."content_refs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
