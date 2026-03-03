ALTER TABLE `sync_operations` ADD `result_status` text;
--> statement-breakpoint
ALTER TABLE `sync_operations` ADD `result_revision_id` text;
--> statement-breakpoint
ALTER TABLE `sync_operations` ADD `result_head_revision_id` text;
--> statement-breakpoint
ALTER TABLE `sync_operations` ADD `result_conflict_path` text;
