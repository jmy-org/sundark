CREATE TABLE `page_contents` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_id` text NOT NULL,
	`owner` text NOT NULL,
	`file_version` text NOT NULL,
	`page` integer NOT NULL,
	`method` text NOT NULL,
	`confidence` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`segments` text NOT NULL,
	`byte_size` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pages_owner_paper` ON `page_contents` (`owner`,`paper_id`);