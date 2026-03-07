import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Button, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Typography, TextField } from '@mui/material';

function Dashboard() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    const res = await axios.get('/api/users');
    setUsers(res.data);
  };

  const handleAction = async (subId, action) => {
    await axios.post(`/api/subscription/${subId}/${action}`);
    fetchUsers();
  };

  const handleEmployeeCount = async (subId, count) => {
    const num = parseInt(count, 10);
    if (isNaN(num) || num < 0) return;
    await axios.put(`/api/subscription/${subId}/employee-count`, { count: num });
    fetchUsers();
  };

  return (
    <TableContainer component={Paper}>
      <Typography variant="h5" sx={{ m: 2 }}>User Subscriptions</Typography>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>User</TableCell>
            <TableCell>Email</TableCell>
            <TableCell>App</TableCell>
            <TableCell>Employees</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Payment</TableCell>
            <TableCell>Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {users.map(user => (
            user.subscriptions.map(sub => (
              <TableRow key={sub._id}>
                <TableCell>{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>{sub.app?.name || ''}</TableCell>
                <TableCell>
                  <TextField
                    type="number"
                    size="small"
                    value={sub.employeeCount || 0}
                    onChange={(e) => handleEmployeeCount(sub._id, e.target.value)}
                    inputProps={{ min: 0, style: { width: 60, textAlign: 'center' } }}
                  />
                </TableCell>
                <TableCell>{sub.active ? 'Active' : 'Inactive'}</TableCell>
                <TableCell>{sub.paymentStatus}</TableCell>
                <TableCell>
                  <Button onClick={() => handleAction(sub._id, 'activate')} disabled={sub.active}>Activate</Button>
                  <Button onClick={() => handleAction(sub._id, 'inactivate')} disabled={!sub.active}>Inactivate</Button>
                  <Button onClick={() => handleAction(sub._id, 'remind')}>Send Reminder</Button>
                </TableCell>
              </TableRow>
            ))
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default Dashboard;
