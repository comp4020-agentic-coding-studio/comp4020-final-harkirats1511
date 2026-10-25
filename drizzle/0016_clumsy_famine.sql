CREATE TABLE `best_votes` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`voter_person_id` text NOT NULL,
	`pick_person_id` text NOT NULL,
	PRIMARY KEY(`game_id`, `round`, `voter_person_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ghost_guesses` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`ghost_person_id` text NOT NULL,
	`guess_person_id` text NOT NULL,
	PRIMARY KEY(`game_id`, `round`, `ghost_person_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `round_moles` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`person_id` text NOT NULL,
	PRIMARY KEY(`game_id`, `round`, `person_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `round_results` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`accused_person_id` text,
	`caught` integer DEFAULT 0 NOT NULL,
	`stole` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`game_id`, `round`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `round_scores` (
	`game_id` text NOT NULL,
	`round` integer NOT NULL,
	`person_id` text NOT NULL,
	`points` integer NOT NULL,
	PRIMARY KEY(`game_id`, `round`, `person_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `game_players` ADD `score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `format` text DEFAULT 'knockout' NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `format` text DEFAULT 'knockout' NOT NULL;