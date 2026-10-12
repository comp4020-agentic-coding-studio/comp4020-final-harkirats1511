CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pin_hash` text NOT NULL,
	`pin_salt` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_name_nocase` ON `people` (lower("name"));--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_person` ON `sessions` (`person_id`);--> statement-breakpoint
CREATE TABLE `table_members` (
	`table_code` text NOT NULL,
	`person_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`table_code`, `person_id`),
	FOREIGN KEY (`table_code`) REFERENCES `tables`(`code`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tables` (
	`code` text PRIMARY KEY NOT NULL,
	`host_person_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`host_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
