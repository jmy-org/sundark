CREATE TABLE `papers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`title` text NOT NULL,
	`authors` text DEFAULT '' NOT NULL,
	`year` text DEFAULT '' NOT NULL,
	`doi` text DEFAULT '' NOT NULL,
	`collection` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`page` integer DEFAULT 1 NOT NULL,
	`zoom` integer DEFAULT 100 NOT NULL,
	`file_name` text,
	`file_key` text,
	`size` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `papers_owner` ON `papers` (`owner`);