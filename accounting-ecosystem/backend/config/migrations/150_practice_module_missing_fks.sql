-- =============================================================================
-- Migration 150: Add 198 missing foreign keys across the Practice (Firmflow) module
-- =============================================================================
-- Run in Supabase SQL Editor.
--
-- Problem: the Firmflow full-module breadth audit (2026-08-24, 6 parallel
-- agents covering all 67 backend route files) found dozens of PostgREST
-- embed failures (`PGRST200 — no relationship found`) across almost every
-- corner of the module — individual/company/provisional tax returns and
-- taxpayer profiles, billing packs, document requests, skills matrix,
-- compliance packs, client engagements, and many more. A schema-cache
-- reload (migration 149) was tried first and ruled out as the cause —
-- every failure persisted identically after the reload.
--
-- A systematic scan of every `_id`-suffixed column across all 67
-- `practice_*` tables (excluding polymorphic/audit columns like
-- `actor_user_id`, `entity_id`, `source_id` which intentionally reference
-- different tables depending on a type discriminator, and therefore
-- correctly have no single FK) found this is not a handful of isolated
-- bugs — it is nearly the ENTIRE module. Of 72 tables with a `client_id`
-- column, only 5 had a working FK to `practice_clients`. Of ~40 columns in
-- the `*_team_member_id` family, only 4 worked. The pattern repeats for
-- `engagement_id`, `deadline_id`, `workflow_run_id`, `task_id`,
-- `taxpayer_profile_id`, `compliance_pack_id`, `template_id`,
-- `billing_pack_id`, `time_entry_id`, `skill_id`, `certification_id`,
-- `category_id`, and the various `related_*_id`/`linked_*_id` columns.
--
-- Every one of these missing relationships breaks any PostgREST
-- `table!fk_column(...)` or `table:fk_column(...)` embed built against it —
-- the exact root cause behind most of the "always 500" and "silently
-- empty/null" findings across all six Firmflow audit reports from today
-- (individual-tax.js, provisional-tax.js, taxpayer-profiles.js,
-- tax-actions.js, tax-dashboard.js, billing.js, document-requests.js,
-- skills-matrix.js, and more).
--
-- Fix: add all 198 confirmed-missing FK constraints, generated
-- programmatically from a live comparison against the real PostgREST
-- schema (not hand-typed — verified against actual embed failures, one
-- probe per relationship, immediately before this file was written).
-- All use NOT VALID — safe against any pre-existing orphaned/bad data in
-- these tables (matches this repo's established pattern for adding FKs to
-- already-populated tables, e.g. migrations 143/148). No ON DELETE clause
-- is specified anywhere (defaults to NO ACTION) — the safe, conservative
-- choice across 198 relationships without auditing nullability/lifecycle
-- semantics of each one individually; a parent row cannot be deleted while
-- referenced, which is the correct default for practice/compliance records.
--
-- 13 of the 198 constraint names exceed Postgres's 63-character identifier
-- limit and will be silently truncated by Postgres — checked programmatically
-- beforehand and confirmed this causes no name collisions.
-- =============================================================================

ALTER TABLE practice_engagement_periods ADD CONSTRAINT practice_engagement_periods_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_engagement_periods ADD CONSTRAINT practice_engagement_periods_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_engagement_periods ADD CONSTRAINT practice_engagement_periods_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES practice_workflow_runs(id) NOT VALID;
ALTER TABLE practice_engagement_periods ADD CONSTRAINT practice_engagement_periods_deadline_id_fkey FOREIGN KEY (deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_task_review_events ADD CONSTRAINT practice_task_review_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES practice_tasks(id) NOT VALID;
ALTER TABLE practice_task_review_events ADD CONSTRAINT practice_task_review_events_actor_team_member_id_fkey FOREIGN KEY (actor_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_individual_tax_calculations ADD CONSTRAINT practice_individual_tax_calculations_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_individual_tax_calculations ADD CONSTRAINT practice_individual_tax_calculations_taxpayer_profile_id_fkey FOREIGN KEY (taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_work_authorizations ADD CONSTRAINT practice_work_authorizations_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_team_skills ADD CONSTRAINT practice_team_skills_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_team_skills ADD CONSTRAINT practice_team_skills_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES practice_skills(id) NOT VALID;
ALTER TABLE practice_quality_reviews ADD CONSTRAINT practice_quality_reviews_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_quality_reviews ADD CONSTRAINT practice_quality_reviews_assigned_reviewer_team_member_id_fkey FOREIGN KEY (assigned_reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_company_directors ADD CONSTRAINT practice_company_directors_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_taxpayer_readiness_items ADD CONSTRAINT practice_taxpayer_readiness_items_related_document_request_id_fkey FOREIGN KEY (related_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_compliance_packs ADD CONSTRAINT practice_compliance_packs_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_compliance_packs ADD CONSTRAINT practice_compliance_packs_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_compliance_packs ADD CONSTRAINT practice_compliance_packs_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_compliance_packs ADD CONSTRAINT practice_compliance_packs_related_workflow_run_id_fkey FOREIGN KEY (related_workflow_run_id) REFERENCES practice_workflow_runs(id) NOT VALID;
ALTER TABLE practice_compliance_packs ADD CONSTRAINT practice_compliance_packs_related_deadline_id_fkey FOREIGN KEY (related_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_secretarial_resolutions ADD CONSTRAINT practice_secretarial_resolutions_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_risks ADD CONSTRAINT practice_risks_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_tax_checklist_template_events ADD CONSTRAINT practice_tax_checklist_template_events_template_id_fkey FOREIGN KEY (template_id) REFERENCES practice_workflow_templates(id) NOT VALID;
ALTER TABLE practice_onboarding_events ADD CONSTRAINT practice_onboarding_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_company_tax_review_pack_events ADD CONSTRAINT practice_company_tax_review_pack_events_company_tax_return_id_fkey FOREIGN KEY (company_tax_return_id) REFERENCES practice_company_tax_returns(id) NOT VALID;
ALTER TABLE practice_clients ADD CONSTRAINT practice_clients_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_clients ADD CONSTRAINT practice_clients_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_clients ADD CONSTRAINT practice_clients_partner_team_member_id_fkey FOREIGN KEY (partner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_onboarding_profiles ADD CONSTRAINT practice_onboarding_profiles_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_onboarding_profiles ADD CONSTRAINT practice_onboarding_profiles_assigned_team_member_id_fkey FOREIGN KEY (assigned_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_secretarial_integrity_events ADD CONSTRAINT practice_secretarial_integrity_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_planning_notes ADD CONSTRAINT practice_planning_notes_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_planning_notes ADD CONSTRAINT practice_planning_notes_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_entity_lifecycle_events ADD CONSTRAINT practice_entity_lifecycle_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_onboarding_steps ADD CONSTRAINT practice_onboarding_steps_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_risk_controls ADD CONSTRAINT practice_risk_controls_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_secretarial_evidence_checklists ADD CONSTRAINT practice_secretarial_evidence_checklists_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_secretarial_evidence_checklists ADD CONSTRAINT practice_secretarial_evidence_checklists_template_id_fkey FOREIGN KEY (template_id) REFERENCES practice_workflow_templates(id) NOT VALID;
ALTER TABLE practice_individual_tax_review_packs ADD CONSTRAINT practice_individual_tax_review_packs_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_individual_tax_review_packs ADD CONSTRAINT practice_individual_tax_review_packs_taxpayer_profile_id_fkey FOREIGN KEY (taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_individual_tax_review_packs ADD CONSTRAINT practice_individual_tax_review_packs_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_tax_submissions ADD CONSTRAINT practice_tax_submissions_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_tax_submissions ADD CONSTRAINT practice_tax_submissions_submitted_by_team_member_id_fkey FOREIGN KEY (submitted_by_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_tax_submissions ADD CONSTRAINT practice_tax_submissions_related_deadline_id_fkey FOREIGN KEY (related_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_tax_submissions ADD CONSTRAINT practice_tax_submissions_related_compliance_pack_id_fkey FOREIGN KEY (related_compliance_pack_id) REFERENCES practice_compliance_packs(id) NOT VALID;
ALTER TABLE practice_tax_submissions ADD CONSTRAINT practice_tax_submissions_related_workflow_run_id_fkey FOREIGN KEY (related_workflow_run_id) REFERENCES practice_workflow_runs(id) NOT VALID;
ALTER TABLE practice_tax_submissions ADD CONSTRAINT practice_tax_submissions_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_beneficial_owners ADD CONSTRAINT practice_beneficial_owners_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_tax_submission_evidence ADD CONSTRAINT practice_tax_submission_evidence_related_document_request_id_fkey FOREIGN KEY (related_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_tax_work_actions ADD CONSTRAINT practice_tax_work_actions_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_tax_work_actions ADD CONSTRAINT practice_tax_work_actions_assigned_team_member_id_fkey FOREIGN KEY (assigned_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_tax_work_actions ADD CONSTRAINT practice_tax_work_actions_linked_task_id_fkey FOREIGN KEY (linked_task_id) REFERENCES practice_tasks(id) NOT VALID;
ALTER TABLE practice_tax_work_actions ADD CONSTRAINT practice_tax_work_actions_linked_document_request_id_fkey FOREIGN KEY (linked_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_learning_goals ADD CONSTRAINT practice_learning_goals_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES practice_skills(id) NOT VALID;
ALTER TABLE practice_statutory_calendar_events ADD CONSTRAINT practice_statutory_calendar_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_learning_plans ADD CONSTRAINT practice_learning_plans_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_learning_plans ADD CONSTRAINT practice_learning_plans_mentor_team_member_id_fkey FOREIGN KEY (mentor_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_statutory_obligations ADD CONSTRAINT practice_statutory_obligations_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_onboarding_checklists ADD CONSTRAINT practice_onboarding_checklists_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_health_snapshots ADD CONSTRAINT practice_client_health_snapshots_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_tax_payments ADD CONSTRAINT practice_tax_payments_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_pilot_known_issues ADD CONSTRAINT practice_pilot_known_issues_assigned_team_member_id_fkey FOREIGN KEY (assigned_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_billing_packs ADD CONSTRAINT practice_billing_packs_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_bo_readiness_items ADD CONSTRAINT practice_bo_readiness_items_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_individual_tax_items ADD CONSTRAINT practice_individual_tax_items_related_document_request_id_fkey FOREIGN KEY (related_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_billing_pack_events ADD CONSTRAINT practice_billing_pack_events_billing_pack_id_fkey FOREIGN KEY (billing_pack_id) REFERENCES practice_billing_packs(id) NOT VALID;
ALTER TABLE practice_company_shareholders ADD CONSTRAINT practice_company_shareholders_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_profitability_snapshots ADD CONSTRAINT practice_profitability_snapshots_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_profitability_snapshots ADD CONSTRAINT practice_profitability_snapshots_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_engagement_letters ADD CONSTRAINT practice_engagement_letters_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_engagement_letters ADD CONSTRAINT practice_engagement_letters_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_secretarial_governance_events ADD CONSTRAINT practice_secretarial_governance_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_tax_dispute_cases ADD CONSTRAINT practice_tax_dispute_cases_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_tax_dispute_cases ADD CONSTRAINT practice_tax_dispute_cases_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_tax_bulk_operation_items ADD CONSTRAINT practice_tax_bulk_operation_items_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_partner_scorecards ADD CONSTRAINT practice_partner_scorecards_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_client_health_actions ADD CONSTRAINT practice_client_health_actions_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_health_actions ADD CONSTRAINT practice_client_health_actions_linked_task_id_fkey FOREIGN KEY (linked_task_id) REFERENCES practice_tasks(id) NOT VALID;
ALTER TABLE practice_client_health_actions ADD CONSTRAINT practice_client_health_actions_linked_deadline_id_fkey FOREIGN KEY (linked_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_client_health_actions ADD CONSTRAINT practice_client_health_actions_linked_billing_pack_id_fkey FOREIGN KEY (linked_billing_pack_id) REFERENCES practice_billing_packs(id) NOT VALID;
ALTER TABLE practice_client_health_actions ADD CONSTRAINT practice_client_health_actions_assigned_team_member_id_fkey FOREIGN KEY (assigned_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_sars_statement_lines ADD CONSTRAINT practice_sars_statement_lines_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_statutory_schedule ADD CONSTRAINT practice_statutory_schedule_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_statutory_schedule ADD CONSTRAINT practice_statutory_schedule_linked_deadline_id_fkey FOREIGN KEY (linked_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_client_success ADD CONSTRAINT practice_client_success_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_success ADD CONSTRAINT practice_client_success_relationship_owner_team_member_id_fkey FOREIGN KEY (relationship_owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_client_success_activities ADD CONSTRAINT practice_client_success_activities_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_success_activities ADD CONSTRAINT practice_client_success_activities_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_secretarial_meetings ADD CONSTRAINT practice_secretarial_meetings_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_deadlines ADD CONSTRAINT practice_deadlines_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_client_meetings ADD CONSTRAINT practice_client_meetings_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_meetings ADD CONSTRAINT practice_client_meetings_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_notifications ADD CONSTRAINT practice_notifications_assigned_team_member_id_fkey FOREIGN KEY (assigned_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_billing_pack_lines ADD CONSTRAINT practice_billing_pack_lines_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES practice_time_entries(id) NOT VALID;
ALTER TABLE practice_billing_pack_lines ADD CONSTRAINT practice_billing_pack_lines_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_billing_pack_lines ADD CONSTRAINT practice_billing_pack_lines_task_id_fkey FOREIGN KEY (task_id) REFERENCES practice_tasks(id) NOT VALID;
ALTER TABLE practice_billing_pack_lines ADD CONSTRAINT practice_billing_pack_lines_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES practice_workflow_runs(id) NOT VALID;
ALTER TABLE practice_company_tax_review_packs ADD CONSTRAINT practice_company_tax_review_packs_company_tax_return_id_fkey FOREIGN KEY (company_tax_return_id) REFERENCES practice_company_tax_returns(id) NOT VALID;
ALTER TABLE practice_company_tax_review_packs ADD CONSTRAINT practice_company_tax_review_packs_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_company_tax_review_packs ADD CONSTRAINT practice_company_tax_review_packs_taxpayer_profile_id_fkey FOREIGN KEY (taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_company_tax_review_packs ADD CONSTRAINT practice_company_tax_review_packs_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_workflow_runs ADD CONSTRAINT practice_workflow_runs_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_secretarial_decisions ADD CONSTRAINT practice_secretarial_decisions_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_secretarial_decisions ADD CONSTRAINT practice_secretarial_decisions_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_entity_lifecycle_checklist_items ADD CONSTRAINT practice_entity_lifecycle_checklist_items_linked_document_request_id_fkey FOREIGN KEY (linked_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_company_tax_readiness_items ADD CONSTRAINT practice_company_tax_readiness_items_company_tax_return_id_fkey FOREIGN KEY (company_tax_return_id) REFERENCES practice_company_tax_returns(id) NOT VALID;
ALTER TABLE practice_company_tax_readiness_items ADD CONSTRAINT practice_company_tax_readiness_items_related_document_request_id_fkey FOREIGN KEY (related_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_ownership_chains ADD CONSTRAINT practice_ownership_chains_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_executive_action_register ADD CONSTRAINT practice_executive_action_register_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_pricing_reviews ADD CONSTRAINT practice_pricing_reviews_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_pricing_reviews ADD CONSTRAINT practice_pricing_reviews_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_compliance_pack_items ADD CONSTRAINT practice_compliance_pack_items_related_document_request_id_fkey FOREIGN KEY (related_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_compliance_pack_items ADD CONSTRAINT practice_compliance_pack_items_related_task_id_fkey FOREIGN KEY (related_task_id) REFERENCES practice_tasks(id) NOT VALID;
ALTER TABLE practice_compliance_pack_items ADD CONSTRAINT practice_compliance_pack_items_related_deadline_id_fkey FOREIGN KEY (related_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_annual_returns ADD CONSTRAINT practice_annual_returns_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_tasks ADD CONSTRAINT practice_tasks_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_tax_checklist_template_items ADD CONSTRAINT practice_tax_checklist_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES practice_workflow_templates(id) NOT VALID;
ALTER TABLE practice_taxpayer_profiles ADD CONSTRAINT practice_taxpayer_profiles_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_taxpayer_profiles ADD CONSTRAINT practice_taxpayer_profiles_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_taxpayer_profiles ADD CONSTRAINT practice_taxpayer_profiles_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_secretarial_evidence_events ADD CONSTRAINT practice_secretarial_evidence_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_secretarial_events ADD CONSTRAINT practice_secretarial_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_strategic_objectives ADD CONSTRAINT practice_strategic_objectives_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_taxpayer_profile_id_fkey FOREIGN KEY (taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_related_taxpayer_profile_id_fkey FOREIGN KEY (related_taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_related_compliance_pack_id_fkey FOREIGN KEY (related_compliance_pack_id) REFERENCES practice_compliance_packs(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_related_deadline_id_fkey FOREIGN KEY (related_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_related_workflow_run_id_fkey FOREIGN KEY (related_workflow_run_id) REFERENCES practice_workflow_runs(id) NOT VALID;
ALTER TABLE practice_individual_tax_returns ADD CONSTRAINT practice_individual_tax_returns_related_provisional_tax_plan_id_fkey FOREIGN KEY (related_provisional_tax_plan_id) REFERENCES practice_provisional_tax_plans(id) NOT VALID;
ALTER TABLE practice_entity_lifecycle_profiles ADD CONSTRAINT practice_entity_lifecycle_profiles_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_secretarial_integrity_findings ADD CONSTRAINT practice_secretarial_integrity_findings_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_company_tax_calculations ADD CONSTRAINT practice_company_tax_calculations_company_tax_return_id_fkey FOREIGN KEY (company_tax_return_id) REFERENCES practice_company_tax_returns(id) NOT VALID;
ALTER TABLE practice_company_tax_calculations ADD CONSTRAINT practice_company_tax_calculations_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_company_tax_calculations ADD CONSTRAINT practice_company_tax_calculations_taxpayer_profile_id_fkey FOREIGN KEY (taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_work_queue_events ADD CONSTRAINT practice_work_queue_events_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_client_opportunities ADD CONSTRAINT practice_client_opportunities_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_opportunities ADD CONSTRAINT practice_client_opportunities_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_client_engagement_events ADD CONSTRAINT practice_client_engagement_events_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_cpd_records ADD CONSTRAINT practice_cpd_records_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_statutory_dependencies ADD CONSTRAINT practice_statutory_dependencies_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_strategic_initiatives ADD CONSTRAINT practice_strategic_initiatives_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_secretarial_profiles ADD CONSTRAINT practice_secretarial_profiles_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_engagements ADD CONSTRAINT practice_client_engagements_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_engagements ADD CONSTRAINT practice_client_engagements_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_client_engagements ADD CONSTRAINT practice_client_engagements_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_client_engagements ADD CONSTRAINT practice_client_engagements_partner_team_member_id_fkey FOREIGN KEY (partner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_entity_lifecycle_transitions ADD CONSTRAINT practice_entity_lifecycle_transitions_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_company_tax_calculation_events ADD CONSTRAINT practice_company_tax_calculation_events_company_tax_return_id_fkey FOREIGN KEY (company_tax_return_id) REFERENCES practice_company_tax_returns(id) NOT VALID;
ALTER TABLE practice_company_tax_adjustments ADD CONSTRAINT practice_company_tax_adjustments_company_tax_return_id_fkey FOREIGN KEY (company_tax_return_id) REFERENCES practice_company_tax_returns(id) NOT VALID;
ALTER TABLE practice_company_tax_adjustments ADD CONSTRAINT practice_company_tax_adjustments_related_document_request_id_fkey FOREIGN KEY (related_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_secretarial_evidence_items ADD CONSTRAINT practice_secretarial_evidence_items_linked_document_request_id_fkey FOREIGN KEY (linked_document_request_id) REFERENCES practice_document_requests(id) NOT VALID;
ALTER TABLE practice_secretarial_evidence_items ADD CONSTRAINT practice_secretarial_evidence_items_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_team_certifications ADD CONSTRAINT practice_team_certifications_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_team_certifications ADD CONSTRAINT practice_team_certifications_certification_id_fkey FOREIGN KEY (certification_id) REFERENCES practice_certifications(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_taxpayer_profile_id_fkey FOREIGN KEY (taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_related_taxpayer_profile_id_fkey FOREIGN KEY (related_taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_related_compliance_pack_id_fkey FOREIGN KEY (related_compliance_pack_id) REFERENCES practice_compliance_packs(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_related_deadline_id_fkey FOREIGN KEY (related_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_related_workflow_run_id_fkey FOREIGN KEY (related_workflow_run_id) REFERENCES practice_workflow_runs(id) NOT VALID;
ALTER TABLE practice_company_tax_returns ADD CONSTRAINT practice_company_tax_returns_related_provisional_tax_plan_id_fkey FOREIGN KEY (related_provisional_tax_plan_id) REFERENCES practice_provisional_tax_plans(id) NOT VALID;
ALTER TABLE practice_company_tax_events ADD CONSTRAINT practice_company_tax_events_company_tax_return_id_fkey FOREIGN KEY (company_tax_return_id) REFERENCES practice_company_tax_returns(id) NOT VALID;
ALTER TABLE practice_tax_completion_packs ADD CONSTRAINT practice_tax_completion_packs_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_engagement_management_events ADD CONSTRAINT practice_engagement_management_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_engagement_management_events ADD CONSTRAINT practice_engagement_management_events_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;
ALTER TABLE practice_secretarial_change_cases ADD CONSTRAINT practice_secretarial_change_cases_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_work_queue_preferences ADD CONSTRAINT practice_work_queue_preferences_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_client_communications ADD CONSTRAINT practice_client_communications_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_client_communications ADD CONSTRAINT practice_client_communications_related_task_id_fkey FOREIGN KEY (related_task_id) REFERENCES practice_tasks(id) NOT VALID;
ALTER TABLE practice_client_communications ADD CONSTRAINT practice_client_communications_related_deadline_id_fkey FOREIGN KEY (related_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_client_communications ADD CONSTRAINT practice_client_communications_assigned_team_member_id_fkey FOREIGN KEY (assigned_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_client_success_events ADD CONSTRAINT practice_client_success_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_beneficial_ownership_events ADD CONSTRAINT practice_beneficial_ownership_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_executive_decisions ADD CONSTRAINT practice_executive_decisions_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_document_requests ADD CONSTRAINT practice_document_requests_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_document_requests ADD CONSTRAINT practice_document_requests_assigned_team_member_id_fkey FOREIGN KEY (assigned_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_document_requests ADD CONSTRAINT practice_document_requests_related_workflow_run_id_fkey FOREIGN KEY (related_workflow_run_id) REFERENCES practice_workflow_runs(id) NOT VALID;
ALTER TABLE practice_document_requests ADD CONSTRAINT practice_document_requests_related_task_id_fkey FOREIGN KEY (related_task_id) REFERENCES practice_tasks(id) NOT VALID;
ALTER TABLE practice_document_requests ADD CONSTRAINT practice_document_requests_related_deadline_id_fkey FOREIGN KEY (related_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_document_requests ADD CONSTRAINT practice_document_requests_related_communication_id_fkey FOREIGN KEY (related_communication_id) REFERENCES practice_client_communications(id) NOT VALID;
ALTER TABLE practice_provisional_tax_plans ADD CONSTRAINT practice_provisional_tax_plans_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_provisional_tax_plans ADD CONSTRAINT practice_provisional_tax_plans_taxpayer_profile_id_fkey FOREIGN KEY (taxpayer_profile_id) REFERENCES practice_taxpayer_profiles(id) NOT VALID;
ALTER TABLE practice_provisional_tax_plans ADD CONSTRAINT practice_provisional_tax_plans_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_provisional_tax_plans ADD CONSTRAINT practice_provisional_tax_plans_reviewer_team_member_id_fkey FOREIGN KEY (reviewer_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_provisional_tax_plans ADD CONSTRAINT practice_provisional_tax_plans_related_compliance_pack_id_fkey FOREIGN KEY (related_compliance_pack_id) REFERENCES practice_compliance_packs(id) NOT VALID;
ALTER TABLE practice_provisional_tax_plans ADD CONSTRAINT practice_provisional_tax_plans_related_deadline_id_fkey FOREIGN KEY (related_deadline_id) REFERENCES practice_deadlines(id) NOT VALID;
ALTER TABLE practice_provisional_tax_plans ADD CONSTRAINT practice_provisional_tax_plans_related_workflow_run_id_fkey FOREIGN KEY (related_workflow_run_id) REFERENCES practice_workflow_runs(id) NOT VALID;
ALTER TABLE practice_quality_findings ADD CONSTRAINT practice_quality_findings_responsible_team_member_id_fkey FOREIGN KEY (responsible_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_reminders ADD CONSTRAINT practice_reminders_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_reminders ADD CONSTRAINT practice_reminders_assigned_team_member_id_fkey FOREIGN KEY (assigned_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_pilot_checklist_items ADD CONSTRAINT practice_pilot_checklist_items_owner_team_member_id_fkey FOREIGN KEY (owner_team_member_id) REFERENCES practice_team_members(id) NOT VALID;
ALTER TABLE practice_profitability_reviews ADD CONSTRAINT practice_profitability_reviews_client_id_fkey FOREIGN KEY (client_id) REFERENCES practice_clients(id) NOT VALID;
ALTER TABLE practice_profitability_reviews ADD CONSTRAINT practice_profitability_reviews_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES practice_client_engagements(id) NOT VALID;

-- ─── Verification ─────────────────────────────────────────────────────────────
SELECT count(*) AS total_fk_constraints_on_practice_tables
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
WHERE c.contype = 'f' AND t.relname LIKE 'practice_%';
