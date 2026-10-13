CREATE TABLE `avatars` (
	`person_id` text PRIMARY KEY NOT NULL,
	`character` text NOT NULL,
	`colour` text NOT NULL,
	`hat` text NOT NULL,
	`accessory` text NOT NULL,
	`aid` text NOT NULL,
	`mood` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
