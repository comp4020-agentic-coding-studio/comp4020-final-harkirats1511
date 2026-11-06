ALTER TABLE `game_prompts` ADD `revealed_at` integer;--> statement-breakpoint
CREATE INDEX `game_prompts_revealed` ON `game_prompts` (`revealed_at`);--> statement-breakpoint
ALTER TABLE `games` ADD `private` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- The shop wall (decision 0011). A game started before this column existed takes its table's flag now
-- (visibility can't change mid-game, so for a running game that is the flag it started with).
UPDATE `games` SET `private` = coalesce((SELECT `tables`.`private` FROM `tables` WHERE `tables`.`code` = `games`.`table_code`), 1);--> statement-breakpoint
-- Rounds already revealed get a time, in their game's order: every round before the one in play, and the
-- one in play once its reveal is up or the game is over with a winner (an abandoned game shows no round).
-- The exact moment wasn't kept, so it is the game's end (or start, while it runs), a millisecond per round.
UPDATE `game_prompts` SET `revealed_at` = (
  SELECT CASE WHEN `games`.`finished_at` IS NOT NULL THEN `games`.`finished_at` - (`games`.`round` - `game_prompts`.`round`)
              ELSE `games`.`started_at` + `game_prompts`.`round` END
  FROM `games` WHERE `games`.`id` = `game_prompts`.`game_id`
) WHERE EXISTS (
  SELECT 1 FROM `games` WHERE `games`.`id` = `game_prompts`.`game_id` AND (
    `game_prompts`.`round` < `games`.`round`
    OR (`game_prompts`.`round` = `games`.`round` AND `games`.`winner` IS NULL AND `games`.`phase` = 'reveal')
    OR (`game_prompts`.`round` = `games`.`round` AND `games`.`winner` IS NOT NULL AND `games`.`winner` <> 'none')
  )
);
