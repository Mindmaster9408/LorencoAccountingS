const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/employees - Fetch all employees for the company
router.get('/', authenticate, authorize('ADMIN', 'ACCOUNTANT'), async (req, res) => {
  const companyId = req.user.companyId;

  try {
    const result = await db.query(
      'SELECT id, employee_code, first_name, last_name, is_active FROM employees WHERE company_id = $1 ORDER BY employee_code',
      [companyId]
    );

    res.json({
      employees: result.rows.map(row => ({
        id: row.id,
        employeeCode: row.employee_code,
        firstName: row.first_name,
        lastName: row.last_name,
        isActive: row.is_active
      }))
    });
  } catch (err) {
    console.error('Get employees error:', err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

// PUT /api/employees - Save/update employees
router.put('/', authenticate, authorize('ADMIN', 'ACCOUNTANT'), async (req, res) => {
  const companyId = req.user.companyId;
  const { employees } = req.body;

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    for (const emp of employees) {
      if (emp.id) {
        // Update existing employee
        await client.query(
          `UPDATE employees
           SET employee_code = $1, first_name = $2, last_name = $3, is_active = $4, updated_at = CURRENT_TIMESTAMP
           WHERE id = $5 AND company_id = $6`,
          [emp.employeeCode, emp.firstName, emp.lastName, emp.isActive, emp.id, companyId]
        );
      } else {
        // Insert new employee
        await client.query(
          `INSERT INTO employees (company_id, employee_code, first_name, last_name, is_active)
           VALUES ($1, $2, $3, $4, $5)`,
          [companyId, emp.employeeCode, emp.firstName, emp.lastName, emp.isActive]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save employees error:', err);
    res.status(500).json({ error: 'Failed to save employees' });
  } finally {
    client.release();
  }
});

module.exports = router;
