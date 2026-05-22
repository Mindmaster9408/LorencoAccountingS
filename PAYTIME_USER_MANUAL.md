# Lorenco Paytime — User Manual

**Version:** 2026  
**Prepared by:** Lorenco Accounting Services  
**Platform:** Lorenco Ecosystem — Paytime Payroll Module

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Selecting Your Company](#2-selecting-your-company)
3. [Dashboard & Navigation](#3-dashboard--navigation)
4. [Company Details & Setup](#4-company-details--setup)
5. [Payroll Items](#5-payroll-items)
6. [Employee Management](#6-employee-management)
7. [Employee Detail & Salary Setup](#7-employee-detail--salary-setup)
8. [Attendance](#8-attendance)
9. [Running Payroll](#9-running-payroll)
10. [Payruns & Payslips](#10-payruns--payslips)
11. [PAYE Reconciliation](#11-paye-reconciliation)
12. [Reports](#12-reports)
13. [Net-to-Gross Calculator](#13-net-to-gross-calculator)
14. [Historical Import](#14-historical-import)
15. [Frequently Asked Questions](#15-frequently-asked-questions)

---

## 1. Getting Started

### 1.1 Logging In

Navigate to the Paytime login page and enter your email address and password, then click **Sign In**.

> **First time?** Use the Sign Up tab to create your account, or contact your accountant — they will set up access for you.

If you have forgotten your password, click **Forgot password?** on the login screen to receive a reset link by email.

---

### 1.2 What Is Paytime?

Paytime is a full-featured cloud payroll system. It handles:

- Employee records and salary structures
- Automatic PAYE, UIF, and SDL calculation (South African tax tables)
- Payslip generation and finalization
- PAYE reconciliation (EMP501 support)
- Reports and compliance exports
- Attendance tracking
- Multi-company / multi-client support

All your data is stored securely in the cloud. There is nothing to install.

---

## 2. Selecting Your Company

After logging in you will land on the **Company Selection** screen.

### 2.1 What You See

Each company or client you have access to appears as a card. The card shows:

| Field | What it means |
|---|---|
| Company Name | The registered name of the business |
| Employees | How many employees are active |
| Active Periods | Payroll periods currently open |
| Financial Year End | The month the tax year ends |
| Tax Status | Whether PAYE / UIF / SDL is registered |

Cards are grouped under **My Companies** (companies you own or manage directly) and **My Clients** (companies assigned to you as an accountant or admin).

### 2.2 Entering a Company

Click the **Select** button on any card to enter that company's payroll environment. All actions from this point apply to that company only.

To switch to a different company at any time, use the **Switch Company** button in the sidebar or the company carousel.

---

## 3. Dashboard & Navigation

Once inside a company, the **Company Dashboard** is your home screen.

### 3.1 The Sidebar

The sidebar appears on every screen and stays fixed as you scroll. It contains:

- The currently selected company name
- Quick navigation links to all modules
- A company carousel for fast switching between companies
- **Switch Company** and **Logout** buttons at the bottom

### 3.2 Main Navigation Sections

| Section | Purpose |
|---|---|
| **Employees** | View and manage all employees |
| **Payroll Items** | Set up salary components, allowances, and deductions |
| **Payroll Execution** | Run payroll for a selected period |
| **Payruns** | View payslips and completed payrun history |
| **PAYE Recon** | Reconcile PAYE with SARS for a tax year |
| **Attendance** | Track employee attendance and hours |
| **Reports** | Generate payroll, compliance, and financial reports |
| **Company Details** | Manage company profile, tax numbers, and banking |

---

## 4. Company Details & Setup

> **Complete this before running your first payroll.** Paytime uses your company details for PAYE calculations, payslip branding, and SARS compliance.

Navigate to **Company Details** from the sidebar.

### 4.1 General Information

| Field | Description |
|---|---|
| Company Name | Registered legal name |
| Trading Name | Trading name (if different) |
| Registration Number | CIPC company registration number |

### 4.2 Tax & Statutory Numbers

These are required for correct SARS calculations and compliance returns.

| Field | Description |
|---|---|
| PAYE Reference Number | Issued by SARS — required for EMP201 submissions |
| UIF Reference Number | Issued by Department of Employment and Labour |
| SDL Reference Number | Skills Development Levy number (if registered) |
| COID Reference | Compensation for Occupational Injuries and Diseases |
| SDL Registered | Toggle ON if your company is liable for SDL |
| UIF Registered | Toggle ON if your company contributes to UIF |

### 4.3 Banking Details

Enter your company bank account. This is used on payslips and for EFT batch export files.

### 4.4 Payroll Settings

| Field | Description |
|---|---|
| Pay Frequency | Monthly, Weekly, Fortnightly, etc. |
| Pay Day | The day of the month employees are paid |
| Normal Working Hours | Used for pro-rata and overtime calculations |

### 4.5 Pay Schedules

Click **Add Schedule** to define when a specific group of employees is paid (e.g., weekly staff vs. monthly staff). Each schedule has a name, frequency, and pay day.

### 4.6 Editing Company Details

Click the **Edit Company Details** button at the top of the page. A form modal will open. Fill in the required fields and click **Save**.

---

## 5. Payroll Items

Payroll items are the building blocks of every employee's salary. Before you can assign a salary to any employee, the relevant payroll items must exist here.

Navigate to **Payroll Items** from the sidebar.

### 5.1 What Are Payroll Items?

A payroll item is any component of an employee's pay — for example:

- **Allowances / Earnings:** Basic Salary, Commission, Overtime, Travel Allowance, Housing Allowance, Annual Bonus
- **Deductions:** Medical Aid, Retirement Fund, Union Fees, Garnishee Orders
- **Statutory:** PAYE (auto-calculated), UIF (auto-calculated), SDL (auto-calculated)

Each item has:

| Property | Description |
|---|---|
| Name | What appears on the payslip |
| Category | Allowance, Deduction, or Benefit |
| Tax Treatment | Whether this item is taxable or non-taxable |
| IRP5 Code | The SARS IRP5 source code for this item (required for annual reconciliation) |

### 5.2 Adding a Payroll Item

1. Click **Add Payroll Item**
2. Enter the item name (e.g., "Travel Allowance")
3. Select the category
4. Set the tax treatment (taxable / non-taxable)
5. Enter the IRP5 code (your accountant can advise if unsure)
6. Click **Save**

> **IRP5 Codes:** Every allowance and deduction must have the correct SARS IRP5 code. Incorrect codes will cause SARS reconciliation failures. Contact your accountant if you are unsure.

### 5.3 Editing or Deleting Items

Each item card has **Edit** and **Delete** buttons. You can only delete an item that is not currently assigned to any employee. Categories are collapsible — click the section header to expand or collapse it.

---

## 6. Employee Management

Navigate to **Employees** from the sidebar.

### 6.1 Employee List

All employees in the company are shown in a table. Columns include employee number, name, position, department, ID number, and employment status.

Use the **Search** bar to quickly find an employee by name.

### 6.2 Adding a New Employee

1. Click **Add Employee**
2. Fill in all required fields (marked with *)
3. Click **Save**

The employee will appear in the list immediately. Proceed to their detail page to set up their salary.

### 6.3 Editing or Removing an Employee

Use the **Edit** (pencil) button on the table row to modify an employee's basic information.

Use the **Delete** button to permanently remove an employee. You will be asked to confirm. Employees with historical payslips cannot be fully deleted — they can be deactivated instead.

---

## 7. Employee Detail & Salary Setup

Click on any employee's name, or use the **View Detail** button, to open the Employee Detail screen. This is where all configuration for a single employee lives.

### 7.1 The Header

The top of the page shows a quick summary:

- Employee number, position, department
- ID / passport number
- Tax number
- Date of birth
- Payment method (EFT / Cash / Cheque)

### 7.2 The Tabs

Employee Detail is organized into tabs. Work through them in order when setting up a new employee.

---

#### Tab: Edit Info

Contains all personal and employment details:

| Section | Fields |
|---|---|
| Personal | Full name, ID number, date of birth, gender, nationality |
| Employment | Employee number, start date, position, department, employment type |
| Contact | Personal email, phone number |
| Payment | Payment method, bank name, account number, branch code, account type |

Click **Save Changes** after editing.

---

#### Tab: Salary

This is where you assign payroll items and amounts to the employee.

**Adding a Salary Item:**
1. Click **Add Item**
2. Select the payroll item from the dropdown (items must exist in Payroll Items first)
3. Enter the amount
4. Click **Save**

You can add as many items as needed. The salary screen shows the total cost to company and the estimated net pay.

**Editing an amount:** Click the edit icon next to any line item and update the value.

**Removing an item:** Click the delete icon on the line item.

> Salary amounts entered here are the **default/standard amounts** for each payroll period. You can override individual amounts during payroll execution if needed.

---

#### Tab: Tax Config

| Field | Description |
|---|---|
| Tax Number | Employee's SARS income tax number — required for IRP5 |
| Voluntary Tax Override | Additional PAYE amount the employee wants deducted each month |

The voluntary tax override is used when an employee has additional income elsewhere and wants extra PAYE withheld to avoid a SARS shortfall at year-end.

---

#### Tab: Leave

Shows all leave balances and leave records for the employee.

**Leave Balances** are shown as cards per leave type (Annual, Sick, Family, etc.) displaying:
- Total entitlement
- Days taken
- Remaining balance

**Leave Records** show each leave request with:
- Date range and type
- Number of days
- Status: **Pending / Approved / Rejected**

**Approving or Rejecting Leave:**
- Click **Approve** or **Reject** on any pending leave request
- The balance updates automatically

---

#### Tab: Attendance

Shows the employee's time and attendance records. Entries can be added manually here or imported via the Attendance module. Attendance data feeds into the payroll engine for pro-rata and overtime calculations.

---

#### Tab: Payslips

Shows all payslips generated for this employee, listed by period.

Each payslip shows:
- Pay period
- Status: **Draft** (not yet finalized) or **Finalized / Locked**
- Net pay for that period
- A **View** button to open the full payslip

> **Finalized payslips are locked.** Once a payrun has been finalized (see Section 9), payslips cannot be changed. This protects your payroll records for audit and compliance purposes.

---

#### Tab: Notes

Add internal notes about the employee. Notes are visible only to users with access to this company. Use this for administrative reminders, performance notes, or HR flags.

---

## 8. Attendance

Navigate to **Attendance** from the sidebar. Attendance is used to track working hours, which can affect pro-rata calculations and overtime in payroll.

### 8.1 Views

| Tab | What it shows |
|---|---|
| Calendar | Monthly calendar grid — click any day to add or view entries |
| Time Entries | Full table of all clock-in / clock-out records |
| Import | Upload attendance data from a file |
| Summary | Overview stats by employee or department |

### 8.2 Stats Bar

The top of the page shows:
- Total days worked
- Total hours logged
- Overtime hours
- Total absences

These update as you filter by month, department, or employee.

### 8.3 Adding a Time Entry Manually

1. Click on a day in the Calendar view, or click **Add Entry** in the Time Entries tab
2. Select the employee
3. Enter the date, clock-in time, and clock-out time
4. Click **Save**

Hours are calculated automatically from the clock-in and clock-out times.

### 8.4 Importing from a Biometric System

Paytime supports importing time records from biometric devices (ZKTeco and compatible formats).

1. Export a CSV or Excel file from your biometric system
2. Go to the **Import** tab in Attendance
3. Drag and drop the file onto the upload area, or click **Browse** to select it
4. Confirm the import

> Imported records appear immediately in the Time Entries table. Review them before running payroll.

---

## 9. Running Payroll

Navigate to **Payroll Execution** from the sidebar. This is the core payroll process.

### 9.1 Overview of the Payroll Process

```
Step 1: Select the pay period (month)
         ↓
Step 2: Select which employees to include
         ↓
Step 3: Review calculated payslips and totals
         ↓
Step 4: Execute Payroll (locks calculations into a snapshot)
         ↓
Step 5: Finalize Payrun (makes payslips immutable and ready for payment)
```

---

### 9.2 Step 1 — Select Pay Period

At the top of the Payroll Execution screen, select the month and year for this payrun using the period selector (format: YYYY-MM, e.g., 2026-05).

### 9.3 Step 2 — Select Employees

A list of all active employees appears with checkboxes. Select the employees you want to include in this run.

- **Select All** — includes all active employees
- **Clear All** — deselects everyone

You may run payroll for a subset of employees (e.g., only monthly staff, or one specific employee for a correction).

### 9.4 Step 3 — Review Calculations

After selecting employees, the system calculates each payslip in real time. For each employee you will see:

- Employee name and number
- **Gross Pay** — total earnings before deductions
- **PAYE** — income tax withheld (calculated from SARS tables)
- **UIF** — Unemployment Insurance Fund contribution
- **SDL** — Skills Development Levy (if applicable)
- **Net Pay** — what the employee takes home

A **Totals Bar** at the top summarises these figures across all selected employees.

Click **Expand** on any employee card to see the full payslip breakdown — every line item, allowance, and deduction.

> **Check these figures carefully before proceeding.** Once executed, the figures are locked into the database snapshot.

### 9.5 Step 4 — Execute Payroll

Click **Execute Payroll**.

This saves a permanent snapshot of every selected employee's payslip for this period into the database. The calculations are frozen at this point.

> If you realise there is an error after executing but **before finalizing**, contact your accountant. There is a correction window before finalization.

### 9.6 Step 5 — Finalize Payrun

Once you are satisfied all payslips are correct, click **Finalize Run**.

**What finalization does:**
- Locks all payslips — they can no longer be edited
- Marks the payrun as complete
- Makes payslips available for download and distribution
- Generates the data for EMP201 and UIF returns

> **Finalization is permanent.** After finalization, the only way to correct a payslip is to create an adjustment run in a subsequent period. This protects your payroll integrity for SARS compliance and auditing.

### 9.7 Viewing Past Payroll Runs

Click the **Historical** tab at the top of the Payroll Execution screen to see all previous runs, their status, and the totals for each period.

---

## 10. Payruns & Payslips

Navigate to **Payruns** from the sidebar. This section is used to view, distribute, and download payslips after execution.

### 10.1 Current Payslips

The **Current Payslips** tab shows employee cards for the most recent payrun. Each card displays:

- Employee name, number, position
- Payment method badge (EFT / Cash / Cheque)
- Payslip status (Draft / Finalized)

Click on an employee card to open their payslip.

### 10.2 Historical Payruns

The **Historical Payruns** tab shows all completed payruns grouped by period. Each payrun entry shows:

- Period title and dates
- Number of employees included
- Total gross and net for the run
- Expandable breakdown table

Expand a payrun to see the individual employee breakdown and access download links.

### 10.3 Downloading Payslips

From a payslip view, click **Download** to save a PDF copy. Payslips can be emailed directly to employees or printed.

### 10.4 Returns (EMP201 & UIF)

The **Returns** tab shows the compliance returns generated from your payruns:

| Return | What it is |
|---|---|
| EMP201 | Monthly PAYE/UIF/SDL return to SARS — submit via eFiling |
| UIF Declaration | Monthly UIF return to the Department of Labour |
| IRP5 / IT3(a) | Annual employee tax certificates — issued at year end |

Each return card shows the period, amounts due, and status (Pending / Submitted). Use the **View** button to open the return data and **Submit** once you have processed it via the relevant platform.

---

## 11. PAYE Reconciliation

Navigate to **PAYE Recon** from the sidebar. This is used at the end of each tax year (February) to reconcile what was submitted to SARS monthly against the actual tax calculated for each employee.

### 11.1 Selecting a Tax Year

Click on a year card at the top of the screen to filter the reconciliation to that year. Year cards show whether the year is **Pending** or **Finalized**.

### 11.2 The Reconciliation Table

The main table shows every employee for the selected year with the following columns:

| Column | Description |
|---|---|
| Employee | Name and number |
| Gross | Total gross earnings for the year |
| PAYE Calculated | Tax the system calculated should have been deducted |
| PAYE Remitted | Tax actually submitted to SARS via EMP201s |
| Difference | Variance between calculated and remitted (should be zero) |
| UIF | Total UIF for the year |
| SDL | Total SDL for the year |

**Differences highlighted in red** indicate a discrepancy that needs investigation before submission. Green (zero difference) means the employee is reconciled.

### 11.3 Manual Adjustments

If a cell is editable, you can enter a manual adjustment to account for corrections. Contact your accountant before making manual entries — incorrect adjustments will cause reconciliation failures with SARS.

### 11.4 Finalizing the Reconciliation

Once all differences are resolved, click **Finalize** to lock the tax year. Finalized years cannot be edited.

> The reconciliation data is used to generate IRP5 / IT3(a) certificates for each employee at year end.

---

## 12. Reports

Navigate to **Reports** from the sidebar. Paytime offers a range of standard reports for payroll management, HR, and SARS compliance.

### 12.1 Available Reports

| Report | What it contains |
|---|---|
| **Transaction History** | All payroll transactions for a selected period |
| **Employee Master List** | Complete directory of all employees with their details |
| **Bank Details** | Employee banking information (marked sensitive — access controlled) |
| **Payroll Summary** | Period-level overview of gross, PAYE, UIF, SDL, net |
| **Audit Trail — User Activity** | Log of who made changes and when |
| **Audit Trail — Per Employee** | All changes made to a specific employee's record |
| **Tax Report (SARS)** | Compliance summary for SARS submission support |
| **Year-to-Date** | Cumulative earnings, deductions, and tax per employee |
| **Variance Report** | Comparison of two periods to identify unexpected changes |

### 12.2 Running a Report

1. Click the report card you want
2. A filter panel opens — set your date range, employees, or departments as required
3. Click **Generate**
4. The results appear in a table or summary card view
5. Click **Export** to download as **CSV**, **Excel**, or **PDF**

> **Bank Details** is flagged as a sensitive report. Access to this report is controlled by user permissions. Only authorised users will see it.

---

## 13. Net-to-Gross Calculator

Navigate to **Net-to-Gross** from the sidebar (or from the employee's salary tab).

This tool answers the question: *"If I want an employee to take home R15,000, what gross salary do I need to pay?"*

### 13.1 How to Use It

**Step 1 — Enter target net pay**
Type the amount the employee should receive in their bank account.

**Step 2 — Enter the pay period**
Select the month (format YYYY-MM).

**Step 3 — Employee options**
- Enter the employee's age (affects rebate eligibility)
- Enter the number of medical aid dependants (affects medical aid tax credit)

**Step 4 — Known allowances and deductions**
If the employee has fixed components (e.g., travel allowance, medical aid deduction), add them to the tables. These are excluded from the reverse calculation and treated as given.

**Step 5 — Calculate**
Click **Calculate**. The system will display:

| Result | Description |
|---|---|
| Required Gross | The gross salary that will produce the target net |
| PAYE | Income tax that will be withheld |
| UIF | UIF contribution |
| SDL | SDL contribution (if applicable) |
| Net Pay | Confirmation — should match your target |

### 13.2 Applying to an Employee

After calculating, click **Apply to Employee** to save the calculated gross salary directly to that employee's salary record. This eliminates manual re-entry.

---

## 14. Historical Import

Navigate to **Historical Import** from the sidebar. Use this section when migrating from a previous payroll system (e.g., Pastel Payroll, VIP, Excel records) and you need to bring prior salary and tax history into Paytime.

> **This module should only be used during initial setup or migration.** Contact your accountant before importing historical data — incorrect imports can affect IRP5 reconciliation and year-to-date figures.

### 14.1 What Can Be Imported

- Prior payslip data (gross, PAYE, UIF, SDL, net per employee per period)
- Year-to-date cumulative figures
- Historical leave balances

### 14.2 Import Process

1. Prepare your data in the required format (your accountant will provide the template)
2. Click **Upload File** and select your prepared file
3. Review the preview — check that columns have been mapped correctly
4. Click **Confirm Import**

The system will validate the data before importing. Any errors will be shown in a list — correct them in your source file and re-upload.

---

## 15. Frequently Asked Questions

**Q: Can I undo a finalized payrun?**  
No. Finalization is permanent to protect your payroll integrity and SARS compliance records. If you need to correct a finalized payslip, run a correction adjustment in the next payroll period and contact your accountant.

---

**Q: Why is PAYE calculated differently for one employee?**  
PAYE depends on the employee's age (rebate tiers), medical aid credits, voluntary tax overrides, and cumulative year-to-date earnings. Check the employee's **Tax Config** tab to verify all fields are correct.

---

**Q: An employee resigned mid-month. How do I pro-rata their salary?**  
Set their last working day in the **Edit Info** tab. Paytime will calculate the pro-rated salary based on the number of working days in that period. Verify the attendance records are up to date for the most accurate result.

---

**Q: How do I add a once-off bonus?**  
Create a "Bonus" payroll item under **Payroll Items** if it does not already exist. Then, during payroll execution, add it as a temporary item for the relevant employee in that period's run only.

---

**Q: What is an IRP5 code and why does it matter?**  
An IRP5 code is a SARS-defined code that categorises each payroll item (e.g., basic salary = 3601, travel allowance = 3701). These codes appear on the employee's annual IRP5 certificate and must be correct for SARS to accept the submission. Your accountant will ensure the correct codes are assigned.

---

**Q: What does "SDL registered" mean?**  
SDL (Skills Development Levy) is a statutory contribution of 1% of gross payroll, paid to SARS and directed to the relevant SETA. Companies with an annual payroll below R500,000 are exempt. Check your company's **Company Details** screen and confirm with your accountant.

---

**Q: Can multiple people use Paytime at the same time?**  
Yes. Paytime supports multiple users per company. User access and permissions are managed by your accountant or system administrator via the **Users** section.

---

**Q: My employee's net pay looks wrong — where do I check?**  
1. Go to **Employees** → select the employee → **Salary** tab. Verify all line items and amounts are correct.  
2. Check the **Tax Config** tab — confirm the tax number is entered and voluntary override is set correctly.  
3. Re-run the payslip from **Payroll Execution** and expand the result card to see the full line-by-line breakdown.

---

*For support, contact Lorenco Accounting Services.*  
*This manual covers the standard Paytime feature set. Your specific configuration may vary.*
