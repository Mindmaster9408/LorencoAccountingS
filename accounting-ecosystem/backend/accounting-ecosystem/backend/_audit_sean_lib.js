'use strict';
require('dotenv').config();
const { supabase } = require('./config/database');
(async () => {
  const { data: lib, error } = await supabase
    .from('sean_global_library')
    .select('*')
    .eq('entity_type', 'payroll_item');
  if (error) { console.log('Error:', error.message); return; }
  console.log('Global library rows:', JSON.stringify(lib, null, 2));
})().catch(console.error);
