CREATE TABLE `analysis_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_id` text NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`language` text NOT NULL,
	`page` integer,
	`file_version` text NOT NULL,
	`source_hash` text NOT NULL,
	`source_pages` text NOT NULL,
	`content` text NOT NULL,
	`byte_size` integer NOT NULL,
	`provenance` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analysis_owner_paper` ON `analysis_artifacts` (`owner`,`paper_id`);