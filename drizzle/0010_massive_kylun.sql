CREATE TABLE `table_removals` (
	`table_code` text NOT NULL,
	`person_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`table_code`, `person_id`),
	FOREIGN KEY (`table_code`) REFERENCES `tables`(`code`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `table_reports` (
	`table_code` text NOT NULL,
	`person_id` text NOT NULL,
	`reason` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`table_code`, `person_id`),
	FOREIGN KEY (`table_code`) REFERENCES `tables`(`code`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tables` ADD `private` integer DEFAULT false NOT NULL;