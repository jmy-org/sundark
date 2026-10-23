CREATE TABLE `paper_figures` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_id` text NOT NULL,
	`owner` text NOT NULL,
	`file_version` text NOT NULL,
	`page` integer NOT NULL,
	`label` text NOT NULL,
	`bbox` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`object_key` text NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `figures_owner_paper` ON `paper_figures` (`owner`,`paper_id`);