ALTER TABLE `artifacts` ADD `description` text NOT NULL;--> statement-breakpoint
ALTER TABLE `builds` ADD `artifact_count` integer DEFAULT 0 NOT NULL;