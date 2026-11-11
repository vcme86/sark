ALTER TABLE attachments ADD COLUMN owner_id TEXT REFERENCES users(id);
--> statement-breakpoint
UPDATE attachments
SET owner_id = (SELECT author_id FROM posts WHERE posts.id = attachments.post_id)
WHERE post_id IS NOT NULL;
