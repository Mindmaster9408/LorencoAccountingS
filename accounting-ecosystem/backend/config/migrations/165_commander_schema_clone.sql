-- ============================================================================
-- Migration 165: Commander schema — clone of every Firmflow (practice_*) table
-- ============================================================================
-- Commander (2026-09-12) is a full functional copy of Firmflow, being adapted
-- for international companies. Rather than duplicating every original CREATE
-- TABLE statement across ~185 tables, each commander_* table is cloned
-- structurally from its practice_* counterpart via LIKE ... INCLUDING ALL —
-- this carries over columns, types, DEFAULTs, CHECK constraints, NOT NULL,
-- indexes, and generated/identity columns exactly as they exist today.
--
-- NOT carried over: FOREIGN KEY constraints (Postgres LIKE ... INCLUDING ALL
-- explicitly excludes them per the Postgres docs on CREATE TABLE LIKE). Every
-- commander_* table therefore starts with the same columns as its practice_*
-- source (e.g. commander_tasks.client_id) but without that column actually
-- being FK-constrained to commander_clients.id yet. The application code
-- (copied from Firmflow into modules/commander + frontend-commander) already
-- enforces company_id/relationship scoping at the query level throughout, as
-- it does for Firmflow today — so this is a data-integrity hardening item to
-- pick up later, not a blocker for using Commander now. See the follow-up
-- note at the bottom of this file.
--
-- Idempotent: IF NOT EXISTS on every CREATE TABLE, safe to re-run (this repo
-- CI applies every migration file on every push, with no tracking table).
-- ============================================================================

CREATE TABLE IF NOT EXISTS commander_alert_rule_events (LIKE practice_alert_rule_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_alert_rule_groups (LIKE practice_alert_rule_groups INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_alert_rules (LIKE practice_alert_rules INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_annual_returns (LIKE practice_annual_returns INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_automation_events (LIKE practice_automation_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_automation_rules (LIKE practice_automation_rules INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_automation_run_steps (LIKE practice_automation_run_steps INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_automation_runs (LIKE practice_automation_runs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_beneficial_owners (LIKE practice_beneficial_owners INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_beneficial_ownership_events (LIKE practice_beneficial_ownership_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_billing_pack_events (LIKE practice_billing_pack_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_billing_pack_lines (LIKE practice_billing_pack_lines INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_billing_packs (LIKE practice_billing_packs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_bo_readiness_items (LIKE practice_bo_readiness_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_certifications (LIKE practice_certifications INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_communications (LIKE practice_client_communications INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_contacts (LIKE practice_client_contacts INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_engagement_events (LIKE practice_client_engagement_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_engagements (LIKE practice_client_engagements INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_health_actions (LIKE practice_client_health_actions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_health_snapshots (LIKE practice_client_health_snapshots INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_meetings (LIKE practice_client_meetings INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_opportunities (LIKE practice_client_opportunities INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_success (LIKE practice_client_success INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_success_activities (LIKE practice_client_success_activities INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_client_success_events (LIKE practice_client_success_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_clients (LIKE practice_clients INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_directors (LIKE practice_company_directors INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_shareholders (LIKE practice_company_shareholders INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_tax_adjustments (LIKE practice_company_tax_adjustments INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_tax_calculation_events (LIKE practice_company_tax_calculation_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_tax_calculations (LIKE practice_company_tax_calculations INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_tax_events (LIKE practice_company_tax_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_tax_readiness_items (LIKE practice_company_tax_readiness_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_tax_returns (LIKE practice_company_tax_returns INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_tax_review_pack_events (LIKE practice_company_tax_review_pack_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_company_tax_review_packs (LIKE practice_company_tax_review_packs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_compliance_pack_events (LIKE practice_compliance_pack_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_compliance_pack_items (LIKE practice_compliance_pack_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_compliance_packs (LIKE practice_compliance_packs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_compliance_rules (LIKE practice_compliance_rules INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_cpd_records (LIKE practice_cpd_records INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_deadline_events (LIKE practice_deadline_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_deadline_settings (LIKE practice_deadline_settings INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_deadlines (LIKE practice_deadlines INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_document_checklist_items (LIKE practice_document_checklist_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_document_checklists (LIKE practice_document_checklists INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_document_requests (LIKE practice_document_requests INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_engagement_letters (LIKE practice_engagement_letters INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_engagement_management_events (LIKE practice_engagement_management_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_engagement_periods (LIKE practice_engagement_periods INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_entity_lifecycle_checklist_items (LIKE practice_entity_lifecycle_checklist_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_entity_lifecycle_events (LIKE practice_entity_lifecycle_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_entity_lifecycle_profiles (LIKE practice_entity_lifecycle_profiles INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_entity_lifecycle_transitions (LIKE practice_entity_lifecycle_transitions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_executive_action_register (LIKE practice_executive_action_register INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_executive_decisions (LIKE practice_executive_decisions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_executive_events (LIKE practice_executive_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_executive_report_sections (LIKE practice_executive_report_sections INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_executive_reports (LIKE practice_executive_reports INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_health_check_events (LIKE practice_health_check_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_health_check_runs (LIKE practice_health_check_runs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_calculation_events (LIKE practice_individual_tax_calculation_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_calculations (LIKE practice_individual_tax_calculations INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_deduction_entries (LIKE practice_individual_tax_deduction_entries INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_events (LIKE practice_individual_tax_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_income_entries (LIKE practice_individual_tax_income_entries INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_items (LIKE practice_individual_tax_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_returns (LIKE practice_individual_tax_returns INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_review_pack_events (LIKE practice_individual_tax_review_pack_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_individual_tax_review_packs (LIKE practice_individual_tax_review_packs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_knowledge_articles (LIKE practice_knowledge_articles INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_knowledge_events (LIKE practice_knowledge_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_knowledge_links (LIKE practice_knowledge_links INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_kpi_snapshot_events (LIKE practice_kpi_snapshot_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_kpi_snapshots (LIKE practice_kpi_snapshots INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_learning_activities (LIKE practice_learning_activities INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_learning_events (LIKE practice_learning_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_learning_goals (LIKE practice_learning_goals INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_learning_plans (LIKE practice_learning_plans INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_learning_progress (LIKE practice_learning_progress INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_notification_events (LIKE practice_notification_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_notifications (LIKE practice_notifications INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_onboarding_checklists (LIKE practice_onboarding_checklists INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_onboarding_events (LIKE practice_onboarding_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_onboarding_profiles (LIKE practice_onboarding_profiles INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_onboarding_steps (LIKE practice_onboarding_steps INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_ownership_chains (LIKE practice_ownership_chains INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_partner_review_pack_events (LIKE practice_partner_review_pack_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_partner_review_packs (LIKE practice_partner_review_packs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_partner_scorecard_events (LIKE practice_partner_scorecard_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_partner_scorecard_reviews (LIKE practice_partner_scorecard_reviews INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_partner_scorecards (LIKE practice_partner_scorecards INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_pilot_checklist_items (LIKE practice_pilot_checklist_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_pilot_events (LIKE practice_pilot_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_pilot_known_issues (LIKE practice_pilot_known_issues INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_pilot_readiness_runs (LIKE practice_pilot_readiness_runs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_planning_events (LIKE practice_planning_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_planning_notes (LIKE practice_planning_notes INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_pricing_events (LIKE practice_pricing_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_pricing_review_items (LIKE practice_pricing_review_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_pricing_reviews (LIKE practice_pricing_reviews INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_profiles (LIKE practice_profiles INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_profitability_events (LIKE practice_profitability_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_profitability_reviews (LIKE practice_profitability_reviews INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_profitability_snapshots (LIKE practice_profitability_snapshots INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_provisional_tax_events (LIKE practice_provisional_tax_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_provisional_tax_periods (LIKE practice_provisional_tax_periods INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_provisional_tax_plans (LIKE practice_provisional_tax_plans INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_quality_events (LIKE practice_quality_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_quality_findings (LIKE practice_quality_findings INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_quality_reviews (LIKE practice_quality_reviews INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_reminders (LIKE practice_reminders INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_resource_forecast_events (LIKE practice_resource_forecast_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_resource_forecast_snapshots (LIKE practice_resource_forecast_snapshots INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_risk_controls (LIKE practice_risk_controls INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_risk_events (LIKE practice_risk_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_risk_reviews (LIKE practice_risk_reviews INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_risks (LIKE practice_risks INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_sars_statement_lines (LIKE practice_sars_statement_lines INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_sars_statement_reconciliation_events (LIKE practice_sars_statement_reconciliation_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_change_cases (LIKE practice_secretarial_change_cases INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_change_checklist_items (LIKE practice_secretarial_change_checklist_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_change_events (LIKE practice_secretarial_change_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_decisions (LIKE practice_secretarial_decisions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_events (LIKE practice_secretarial_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_evidence_checklists (LIKE practice_secretarial_evidence_checklists INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_evidence_events (LIKE practice_secretarial_evidence_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_evidence_items (LIKE practice_secretarial_evidence_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_evidence_templates (LIKE practice_secretarial_evidence_templates INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_governance_events (LIKE practice_secretarial_governance_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_integrity_events (LIKE practice_secretarial_integrity_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_integrity_findings (LIKE practice_secretarial_integrity_findings INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_integrity_runs (LIKE practice_secretarial_integrity_runs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_meeting_attendees (LIKE practice_secretarial_meeting_attendees INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_meetings (LIKE practice_secretarial_meetings INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_profiles (LIKE practice_secretarial_profiles INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_secretarial_resolutions (LIKE practice_secretarial_resolutions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_service_catalog (LIKE practice_service_catalog INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_skill_categories (LIKE practice_skill_categories INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_skill_events (LIKE practice_skill_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_skills (LIKE practice_skills INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_sop_events (LIKE practice_sop_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_sop_links (LIKE practice_sop_links INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_sop_templates (LIKE practice_sop_templates INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_statutory_calendar_events (LIKE practice_statutory_calendar_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_statutory_dependencies (LIKE practice_statutory_dependencies INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_statutory_obligations (LIKE practice_statutory_obligations INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_statutory_schedule (LIKE practice_statutory_schedule INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_strategic_events (LIKE practice_strategic_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_strategic_initiatives (LIKE practice_strategic_initiatives INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_strategic_kpi_links (LIKE practice_strategic_kpi_links INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_strategic_objectives (LIKE practice_strategic_objectives INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_strategic_plans (LIKE practice_strategic_plans INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_strategic_reviews (LIKE practice_strategic_reviews INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_task_review_events (LIKE practice_task_review_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tasks (LIKE practice_tasks INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_brackets (LIKE practice_tax_brackets INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_bulk_operation_events (LIKE practice_tax_bulk_operation_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_bulk_operation_items (LIKE practice_tax_bulk_operation_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_bulk_operations (LIKE practice_tax_bulk_operations INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_checklist_template_events (LIKE practice_tax_checklist_template_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_checklist_template_items (LIKE practice_tax_checklist_template_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_checklist_templates (LIKE practice_tax_checklist_templates INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_completion_events (LIKE practice_tax_completion_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_completion_items (LIKE practice_tax_completion_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_completion_packs (LIKE practice_tax_completion_packs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_config_events (LIKE practice_tax_config_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_dispute_cases (LIKE practice_tax_dispute_cases INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_dispute_events (LIKE practice_tax_dispute_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_dispute_evidence (LIKE practice_tax_dispute_evidence INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_payment_events (LIKE practice_tax_payment_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_payments (LIKE practice_tax_payments INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_pipeline_events (LIKE practice_tax_pipeline_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_reporting_snapshots (LIKE practice_tax_reporting_snapshots INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_submission_events (LIKE practice_tax_submission_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_submission_evidence (LIKE practice_tax_submission_evidence INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_submissions (LIKE practice_tax_submissions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_work_action_events (LIKE practice_tax_work_action_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_work_actions (LIKE practice_tax_work_actions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_tax_year_configs (LIKE practice_tax_year_configs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_taxpayer_deductions (LIKE practice_taxpayer_deductions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_taxpayer_income_sources (LIKE practice_taxpayer_income_sources INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_taxpayer_profiles (LIKE practice_taxpayer_profiles INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_taxpayer_readiness_items (LIKE practice_taxpayer_readiness_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_team_certifications (LIKE practice_team_certifications INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_team_members (LIKE practice_team_members INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_team_skills (LIKE practice_team_skills INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_time_entries (LIKE practice_time_entries INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_work_authorization_events (LIKE practice_work_authorization_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_work_authorizations (LIKE practice_work_authorizations INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_work_delegation_events (LIKE practice_work_delegation_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_work_delegations (LIKE practice_work_delegations INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_work_queue_events (LIKE practice_work_queue_events INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_work_queue_preferences (LIKE practice_work_queue_preferences INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_workflow_run_steps (LIKE practice_workflow_run_steps INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_workflow_runs (LIKE practice_workflow_runs INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_workflow_template_steps (LIKE practice_workflow_template_steps INCLUDING ALL);
CREATE TABLE IF NOT EXISTS commander_workflow_templates (LIKE practice_workflow_templates INCLUDING ALL);

-- ============================================================================
-- FOLLOW-UP NOTE
-- Area: Commander schema (commander_* tables)
-- Dependency: foreign key relationships between commander_* tables
-- What was done now: structural clone (columns/types/defaults/checks/indexes)
--   of all 185 practice_* tables into commander_* equivalents
-- What still needs to be checked: FK constraints were NOT copied (Postgres
--   LIKE...INCLUDING ALL never copies foreign keys). Add them once Commander
--   actual data model is confirmed adapted for international requirements —
--   no point wiring FKs to a schema that may still change per-column.
-- Risk if not checked: relies entirely on application-level scoping (same
--   as Firmflow already does throughout) rather than DB-level referential
--   integrity until FKs are added.
-- Recommended next review point: once Commander adapted data model is
--   settled (post-adaptation, before onboarding a real international client).
-- ============================================================================
