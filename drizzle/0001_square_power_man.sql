CREATE TABLE `taste_tracks` (
	`person_id` text NOT NULL,
	`track_id` integer NOT NULL,
	`title` text NOT NULL,
	`artist` text NOT NULL,
	`album` text,
	`cover` text,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `track_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
