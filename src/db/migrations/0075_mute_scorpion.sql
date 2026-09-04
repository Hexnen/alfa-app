ALTER TABLE `offers` ADD `share_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `offers_share_token_uidx` ON `offers` (`share_token`);