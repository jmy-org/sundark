CREATE TABLE `page_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_id` text NOT NULL,
	`owner` text NOT NULL,
	`file_version` text NOT NULL,
	`page` integer NOT NULL,
	`outcome` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outcomes_owner_paper` ON `page_outcomes` (`owner`,`paper_id`);--> statement-breakpoint
ALTER TABLE `papers` ADD `file_sha256` text;--> statement-breakpoint
ALTER TABLE `papers` ADD `page_count` integer;--> statement-breakpoint
ALTER TABLE `papers` ADD `import_request_id` text;--> statement-breakpoint
ALTER TABLE `papers` ADD `import_file_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `papers_owner_import` ON `papers` (`owner`,`import_request_id`);