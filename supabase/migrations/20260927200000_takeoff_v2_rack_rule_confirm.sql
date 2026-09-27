-- WF6: each rack rule is reviewed and confirmed by the user before it is applied.
-- Editing a rule, or a sheet re-read that changes it, clears the confirmation.
ALTER TABLE takeoff.rack_rules
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN confirmed_by uuid REFERENCES auth.users(id);
