import React from 'react';
import { Box, Typography, Divider, Container, Paper } from '@mui/material';
import AppManagement from './AppManagement';
import Dashboard from './Dashboard';

function App() {
  return (
    <Box sx={{ minHeight: '100vh', background: '#f5f6fa' }}>
      <Container maxWidth="xl" sx={{ py: 4 }}>

        {/* ── Page header ── */}
        <Box sx={{
          mb: 4, p: 3,
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          borderRadius: 3, color: 'white',
          boxShadow: '0 4px 20px rgba(102,126,234,0.4)'
        }}>
          <Typography variant="h4" fontWeight={800}>Lorenco Admin Panel</Typography>
          <Typography variant="body2" sx={{ opacity: 0.85, mt: 0.5 }}>
            Manage apps, packages, add-ons and customer billing
          </Typography>
        </Box>

        {/* ── Apps section ── */}
        <Paper elevation={0} sx={{ p: 3, mb: 5, borderRadius: 3, border: '1px solid #e8eaff' }}>
          <Typography variant="h5" fontWeight={700} sx={{ mb: 3, color: '#333' }}>
            Apps
          </Typography>
          <AppManagement />
        </Paper>

        <Divider sx={{ mb: 5, borderColor: '#e0e0e0' }} />

        {/* ── Billing section ── */}
        <Paper elevation={0} sx={{ borderRadius: 3, border: '1px solid #e8eaff', overflow: 'hidden' }}>
          <Box sx={{ p: 3, pb: 0 }}>
            <Typography variant="h5" fontWeight={700} sx={{ mb: 1, color: '#333' }}>
              Billing
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Customer subscriptions and payment status
            </Typography>
          </Box>
          <Dashboard />
        </Paper>

      </Container>
    </Box>
  );
}

export default App;

