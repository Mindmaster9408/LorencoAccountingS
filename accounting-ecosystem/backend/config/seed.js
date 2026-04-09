/**
 * ============================================================================
 * Database Seed — Master Admin Account
 * ============================================================================
 * Creates the master admin user + default company on first run.
 * Skips if users already exist. Safe to run on every startup.
 * ============================================================================
 */

const bcrypt = require('bcrypt');

const MASTER_USER = {
  username: 'ruanvlog@lorenco.co.za',
  email: 'ruanvlog@lorenco.co.za',
  full_name: 'Ruan',
  password: 'Mindmaster@277477',
  is_super_admin: true,
  role: 'super_admin'
};

const DEFAULT_COMPANY = {
  company_name: 'The Infinite Legacy',
  trading_name: 'The Infinite Legacy',
  is_active: true,
  modules_enabled: ['pos', 'payroll', 'accounting', 'sean'],
  subscription_status: 'active'
};

async function seedMasterAdmin(supabase) {
  try {
    // Check if any users exist
    const { data: existingUsers, error: checkError } = await supabase
      .from('users')
      .select('id')
      .limit(1);

    if (checkError) {
      console.error('  ⚠️  Seed: Could not check users table:', checkError.message);
      return;
    }

    if (existingUsers && existingUsers.length > 0) {
      console.log('  ✅ Users exist — skipping seed');
      return;
    }

    console.log('  🌱 No users found — seeding master admin...');

    // Hash master password
    const password_hash = await bcrypt.hash(MASTER_USER.password, 12);

    // Create master user
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        username: MASTER_USER.username,
        email: MASTER_USER.email,
        full_name: MASTER_USER.full_name,
        password_hash,
        role: MASTER_USER.role,
        is_super_admin: MASTER_USER.is_super_admin,
        is_active: true
      })
      .select()
      .single();

    if (userError) {
      console.error('  ❌ Seed: Failed to create user:', userError.message);
      return;
    }
    console.log(`  ✅ Master admin created (ID: ${user.id}) — ${MASTER_USER.email}`);

    // Ensure company exists
    let { data: company } = await supabase
      .from('companies')
      .select('id')
      .limit(1)
      .single();

    if (!company) {
      const { data: newCompany, error: compError } = await supabase
        .from('companies')
        .insert(DEFAULT_COMPANY)
        .select()
        .single();

      if (compError) {
        console.error('  ❌ Seed: Failed to create company:', compError.message);
        return;
      }
      company = newCompany;
      console.log(`  ✅ Default company created (ID: ${company.id}) — ${DEFAULT_COMPANY.company_name}`);
    }

    // Link user to company as super_admin
    const { error: linkError } = await supabase
      .from('user_company_access')
      .insert({
        user_id: user.id,
        company_id: company.id,
        role: 'super_admin',
        is_primary: true,
        is_active: true
      });

    if (linkError) {
      console.error('  ❌ Seed: Failed to link user to company:', linkError.message);
    } else {
      console.log(`  ✅ User linked to company as business_owner`);
    }

    console.log('\n  🎉 Seed complete! Login with:');
    console.log(`     Email:    ${MASTER_USER.email}`);
    console.log(`     Password: ${MASTER_USER.password}\n`);

  } catch (err) {
    console.error('  ❌ Seed error:', err.message);
  }
}

/**
 * Ensure additional practice users exist.
 * Safe to call on every startup — skips if user already exists.
 */
async function seedAdditionalUsers(supabase) {
  const additionalUsers = [
    {
      username: 'mj@lorenco.co.za',
      email: 'mj@lorenco.co.za',
      full_name: 'MJ van Loggerenberg',
      password: 'mJmR@9423$',
      role: 'business_owner',
      is_super_admin: false
    }
  ];

  for (const u of additionalUsers) {
    try {
      // Check if user already exists
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('username', u.username)
        .maybeSingle();

      if (existing) {
        console.log(`  ✅ User ${u.email} already exists — skipping`);
        continue;
      }

      // Hash password
      const password_hash = await bcrypt.hash(u.password, 12);

      // Create user
      const { data: newUser, error: userError } = await supabase
        .from('users')
        .insert({
          username: u.username,
          email: u.email,
          full_name: u.full_name,
          password_hash,
          role: u.role,
          is_super_admin: u.is_super_admin,
          is_active: true
        })
        .select()
        .single();

      if (userError) {
        console.error(`  ❌ Seed: Failed to create ${u.email}:`, userError.message);
        continue;
      }

      console.log(`  ✅ User created: ${u.email} (${u.role})`);

      // Link user to The Infinite Legacy company
      const { data: company } = await supabase
        .from('companies')
        .select('id')
        .ilike('company_name', '%Infinite Legacy%')
        .maybeSingle();

      if (company) {
        const { error: linkError } = await supabase
          .from('user_company_access')
          .insert({
            user_id: newUser.id,
            company_id: company.id,
            role: u.role,
            is_primary: true,
            is_active: true
          });

        if (!linkError) {
          console.log(`  ✅ ${u.email} linked to The Infinite Legacy as ${u.role}`);
        } else {
          console.error(`  ❌ Failed to link ${u.email} to company:`, linkError.message);
        }
      } else {
        console.warn(`  ⚠️  The Infinite Legacy company not found — ${u.email} created but not linked to a company`);
      }
    } catch (err) {
      console.error(`  ❌ Error seeding user ${u.email}:`, err.message);
    }
  }
}

/**
 * Force-reset master admin password.
 * Only runs when FORCE_RESET_ADMIN=true is set in the environment.
 * IMPORTANT: Remove this env var from Zeabur after the reset is confirmed.
 */
async function forceResetMasterAdmin(supabase) {
  if (process.env.FORCE_RESET_ADMIN !== 'true') return;

  console.log('  ⚠️  FORCE_RESET_ADMIN=true — resetting master admin password...');

  try {
    const password_hash = await bcrypt.hash(MASTER_USER.password, 12);

    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id')
      .or(`username.eq.${MASTER_USER.username},email.eq.${MASTER_USER.email}`)
      .maybeSingle();

    if (findError) {
      console.error('  ❌ Force-reset: Could not find user:', findError.message);
      return;
    }

    if (!user) {
      // User doesn't exist at all — create them
      console.log('  🌱 Master admin not found — creating...');
      await seedMasterAdmin(supabase);
      return;
    }

    // Update password + ensure is_active + is_super_admin
    const { error: updateError } = await supabase
      .from('users')
      .update({
        password_hash,
        is_active: true,
        is_super_admin: true,
        role: 'super_admin'
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('  ❌ Force-reset: Failed to update password:', updateError.message);
    } else {
      console.log(`  ✅ Master admin password reset successfully — ${MASTER_USER.email}`);
      console.log('  ⚠️  IMPORTANT: Remove FORCE_RESET_ADMIN from Zeabur environment variables now.');
    }
  } catch (err) {
    console.error('  ❌ Force-reset error:', err.message);
  }
}

module.exports = { seedMasterAdmin, seedAdditionalUsers, forceResetMasterAdmin };
