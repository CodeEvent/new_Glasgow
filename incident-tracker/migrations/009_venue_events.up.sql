-- =====================================================================
-- 009_venue_events (UP)
-- Each match or concert, started and ended in the app. When an event ends,
-- its final numbers (counts only: no seats, descriptions or names of the
-- public) are kept here for good, after the records themselves are deleted.
-- =====================================================================

CREATE TABLE venue_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(80) NOT NULL,
    started_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    ended_at    TIMESTAMP WITH TIME ZONE,
    started_by  VARCHAR(60) NOT NULL,
    ended_by    VARCHAR(60),
    summary     JSONB,
    CONSTRAINT chk_venue_events_name_not_blank CHECK (length(btrim(name)) > 0),
    CONSTRAINT chk_venue_events_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- Only one event can be running.
CREATE UNIQUE INDEX idx_venue_events_one_open ON venue_events ((ended_at IS NULL)) WHERE ended_at IS NULL;
CREATE INDEX idx_venue_events_started ON venue_events(started_at DESC);
