import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Accordion, AccordionSummary, AccordionDetails,
  Typography, Button, Chip, Table, TableHead, TableBody,
  TableRow, TableCell, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, MenuItem, Switch, FormControlLabel,
  Divider, Box, CircularProgress
} from '@mui/material';

// ─── Package form dialog ─────────────────────────────────────────────────────

function PackageDialog({ open, pkg, appId, onClose, onSaved }) {
  const blank = { name: '', price: 0, billingCycle: 'monthly', maxEmployees: 0, features: '', isActive: true };
  const [form, setForm] = useState(blank);

  useEffect(() => {
    setForm(pkg ? { ...pkg, features: (pkg.features || []).join(', ') } : { ...blank });
  }, [pkg, open]); // eslint-disable-line

  const handleSave = async () => {
    if (!form.name.trim()) { alert('Package name is required'); return; }
    const payload = {
      ...form,
      features: form.features.split(',').map(f => f.trim()).filter(Boolean)
    };
    if (pkg) {
      await axios.put(`/api/packages/${pkg._id}`, payload);
    } else {
      await axios.post(`/api/apps/${appId}/packages`, payload);
    }
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white' }}>
        {pkg ? 'Edit Package' : 'Add Package'}
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <TextField label="Package Name" fullWidth margin="dense" value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })} />
        <TextField label="Price (R)" type="number" fullWidth margin="dense" value={form.price}
          onChange={e => setForm({ ...form, price: parseFloat(e.target.value) || 0 })}
          inputProps={{ min: 0, step: 0.01 }} />
        <TextField label="Billing Cycle" select fullWidth margin="dense" value={form.billingCycle}
          onChange={e => setForm({ ...form, billingCycle: e.target.value })}>
          <MenuItem value="monthly">Monthly</MenuItem>
          <MenuItem value="annual">Annual</MenuItem>
        </TextField>
        <TextField label="Max Employees (0 = unlimited)" type="number" fullWidth margin="dense"
          value={form.maxEmployees}
          onChange={e => setForm({ ...form, maxEmployees: parseInt(e.target.value) || 0 })}
          inputProps={{ min: 0 }} />
        <TextField label="Features (comma-separated)" fullWidth margin="dense" multiline rows={3}
          placeholder="e.g. Payroll runs, Leave management, Tax calculations"
          value={form.features}
          onChange={e => setForm({ ...form, features: e.target.value })} />
        <FormControlLabel sx={{ mt: 1 }}
          control={<Switch checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} />}
          label="Active" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained"
          sx={{ background: 'linear-gradient(135deg, #667eea, #764ba2)' }}>
          Save Package
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ─── Addon form dialog ────────────────────────────────────────────────────────

function AddonDialog({ open, addon, appId, onClose, onSaved }) {
  const blank = { name: '', price: 0, billingCycle: 'monthly', description: '', isActive: true };
  const [form, setForm] = useState(blank);

  useEffect(() => {
    setForm(addon ? { ...addon } : { ...blank });
  }, [addon, open]); // eslint-disable-line

  const handleSave = async () => {
    if (!form.name.trim()) { alert('Add-on name is required'); return; }
    const payload = { ...form };
    if (addon) {
      await axios.put(`/api/addons/${addon._id}`, payload);
    } else {
      await axios.post(`/api/apps/${appId}/addons`, payload);
    }
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ background: 'linear-gradient(135deg, #764ba2, #667eea)', color: 'white' }}>
        {addon ? 'Edit Add-on' : 'Add Add-on'}
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <TextField label="Add-on Name" fullWidth margin="dense" value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })} />
        <TextField label="Price (R)" type="number" fullWidth margin="dense" value={form.price}
          onChange={e => setForm({ ...form, price: parseFloat(e.target.value) || 0 })}
          inputProps={{ min: 0, step: 0.01 }} />
        <TextField label="Billing Cycle" select fullWidth margin="dense" value={form.billingCycle}
          onChange={e => setForm({ ...form, billingCycle: e.target.value })}>
          <MenuItem value="monthly">Monthly</MenuItem>
          <MenuItem value="annual">Annual</MenuItem>
        </TextField>
        <TextField label="Description" fullWidth margin="dense" multiline rows={3}
          placeholder="What does this add-on provide?"
          value={form.description}
          onChange={e => setForm({ ...form, description: e.target.value })} />
        <FormControlLabel sx={{ mt: 1 }}
          control={<Switch checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} />}
          label="Active" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained"
          sx={{ background: 'linear-gradient(135deg, #764ba2, #667eea)' }}>
          Save Add-on
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ─── Main AppManagement component ────────────────────────────────────────────

function AppManagement() {
  const [apps, setApps] = useState([]);
  // Per-app data cache: { [appId]: { packages, addons, loading } }
  const [appData, setAppData] = useState({});

  const [pkgDialog, setPkgDialog] = useState({ open: false, appId: null, pkg: null });
  const [addonDialog, setAddonDialog] = useState({ open: false, appId: null, addon: null });

  useEffect(() => { fetchApps(); }, []);

  const fetchApps = async () => {
    const res = await axios.get('/api/apps');
    setApps(res.data);
  };

  const loadAppData = async (appId) => {
    if (appData[appId]) return; // already loaded
    setAppData(d => ({ ...d, [appId]: { packages: [], addons: [], loading: true } }));
    const [pkgRes, addonRes] = await Promise.all([
      axios.get(`/api/apps/${appId}/packages`),
      axios.get(`/api/apps/${appId}/addons`)
    ]);
    setAppData(d => ({ ...d, [appId]: { packages: pkgRes.data, addons: addonRes.data, loading: false } }));
  };

  const reloadAppData = async (appId) => {
    const [pkgRes, addonRes] = await Promise.all([
      axios.get(`/api/apps/${appId}/packages`),
      axios.get(`/api/apps/${appId}/addons`)
    ]);
    setAppData(d => ({ ...d, [appId]: { packages: pkgRes.data, addons: addonRes.data, loading: false } }));
  };

  const deletePackage = async (pkgId, appId) => {
    if (!window.confirm('Delete this package?')) return;
    await axios.delete(`/api/packages/${pkgId}`);
    reloadAppData(appId);
  };

  const deleteAddon = async (addonId, appId) => {
    if (!window.confirm('Delete this add-on?')) return;
    await axios.delete(`/api/addons/${addonId}`);
    reloadAppData(appId);
  };

  const lorencoApps = apps.filter(a => a.company === 'Lorenco');
  const otherApps   = apps.filter(a => a.company !== 'Lorenco');

  const renderApp = (app) => {
    const data = appData[app._id] || { packages: [], addons: [], loading: false };

    return (
      <Accordion
        key={app._id}
        onChange={(_, expanded) => { if (expanded) loadAppData(app._id); }}
        sx={{ mb: 1.5, borderRadius: '10px !important', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', '&:before': { display: 'none' } }}
      >
        {/* ── Accordion header ── */}
        <AccordionSummary
          expandIcon={<span style={{ color: 'white', fontSize: 20, lineHeight: 1 }}>▾</span>}
          sx={{
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            borderRadius: 'inherit',
            minHeight: 56,
            '&.Mui-expanded': { borderRadius: '10px 10px 0 0' }
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Typography fontWeight={700} fontSize="1rem">{app.name}</Typography>
            <Chip
              label={app.company}
              size="small"
              sx={{ background: 'rgba(255,255,255,0.22)', color: 'white', fontWeight: 600, fontSize: '0.72rem' }}
            />
          </Box>
        </AccordionSummary>

        {/* ── Accordion body ── */}
        <AccordionDetails sx={{ p: 0 }}>
          {data.loading ? (
            <Box sx={{ p: 4, textAlign: 'center' }}>
              <CircularProgress size={28} sx={{ color: '#667eea' }} />
            </Box>
          ) : (
            <Box>
              {/* ── PACKAGES ── */}
              <Box sx={{ p: 2.5, background: '#f8f9ff' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                  <Typography variant="subtitle1" fontWeight={700} sx={{ color: '#667eea' }}>
                    📦 Packages
                  </Typography>
                  <Button
                    size="small"
                    variant="contained"
                    sx={{ background: '#667eea', '&:hover': { background: '#5567d5' }, textTransform: 'none' }}
                    onClick={() => setPkgDialog({ open: true, appId: app._id, pkg: null })}
                  >
                    + Add Package
                  </Button>
                </Box>

                {data.packages.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 1, fontStyle: 'italic' }}>
                    No packages yet — add one to get started.
                  </Typography>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow sx={{ '& th': { fontWeight: 700, background: '#eef0ff', fontSize: '0.8rem', borderBottom: '2px solid #d0d4ff' } }}>
                        <TableCell>Name</TableCell>
                        <TableCell align="right">Price</TableCell>
                        <TableCell>Billing</TableCell>
                        <TableCell align="center">Max&nbsp;Employees</TableCell>
                        <TableCell>Features</TableCell>
                        <TableCell align="center">Status</TableCell>
                        <TableCell align="center">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.packages.map(pkg => (
                        <TableRow key={pkg._id} hover>
                          <TableCell><strong>{pkg.name}</strong></TableCell>
                          <TableCell align="right">R {(pkg.price || 0).toFixed(2)}</TableCell>
                          <TableCell sx={{ textTransform: 'capitalize' }}>{pkg.billingCycle}</TableCell>
                          <TableCell align="center">{pkg.maxEmployees || '∞'}</TableCell>
                          <TableCell>
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                              {(pkg.features || []).map((f, i) => (
                                <Chip key={i} label={f} size="small" sx={{ fontSize: '0.7rem' }} />
                              ))}
                            </Box>
                          </TableCell>
                          <TableCell align="center">
                            <Chip
                              label={pkg.isActive ? 'Active' : 'Inactive'}
                              color={pkg.isActive ? 'success' : 'default'}
                              size="small"
                            />
                          </TableCell>
                          <TableCell align="center">
                            <Button
                              size="small"
                              variant="outlined"
                              sx={{ mr: 0.5, textTransform: 'none', minWidth: 50, fontSize: '0.75rem' }}
                              onClick={() => setPkgDialog({ open: true, appId: app._id, pkg })}
                            >
                              Edit
                            </Button>
                            <Button
                              size="small"
                              variant="outlined"
                              color="error"
                              sx={{ textTransform: 'none', minWidth: 50, fontSize: '0.75rem' }}
                              onClick={() => deletePackage(pkg._id, app._id)}
                            >
                              Delete
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Box>

              <Divider />

              {/* ── ADD-ONS ── */}
              <Box sx={{ p: 2.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                  <Typography variant="subtitle1" fontWeight={700} sx={{ color: '#764ba2' }}>
                    🔌 Add-ons
                  </Typography>
                  <Button
                    size="small"
                    variant="contained"
                    sx={{ background: '#764ba2', '&:hover': { background: '#6340a0' }, textTransform: 'none' }}
                    onClick={() => setAddonDialog({ open: true, appId: app._id, addon: null })}
                  >
                    + Add Add-on
                  </Button>
                </Box>

                {data.addons.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 1, fontStyle: 'italic' }}>
                    No add-ons yet — add one to get started.
                  </Typography>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow sx={{ '& th': { fontWeight: 700, background: '#f5eeff', fontSize: '0.8rem', borderBottom: '2px solid #ddc4ff' } }}>
                        <TableCell>Name</TableCell>
                        <TableCell align="right">Price</TableCell>
                        <TableCell>Billing</TableCell>
                        <TableCell>Description</TableCell>
                        <TableCell align="center">Status</TableCell>
                        <TableCell align="center">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.addons.map(addon => (
                        <TableRow key={addon._id} hover>
                          <TableCell><strong>{addon.name}</strong></TableCell>
                          <TableCell align="right">R {(addon.price || 0).toFixed(2)}</TableCell>
                          <TableCell sx={{ textTransform: 'capitalize' }}>{addon.billingCycle}</TableCell>
                          <TableCell>{addon.description}</TableCell>
                          <TableCell align="center">
                            <Chip
                              label={addon.isActive ? 'Active' : 'Inactive'}
                              color={addon.isActive ? 'success' : 'default'}
                              size="small"
                            />
                          </TableCell>
                          <TableCell align="center">
                            <Button
                              size="small"
                              variant="outlined"
                              sx={{ mr: 0.5, textTransform: 'none', minWidth: 50, fontSize: '0.75rem' }}
                              onClick={() => setAddonDialog({ open: true, appId: app._id, addon })}
                            >
                              Edit
                            </Button>
                            <Button
                              size="small"
                              variant="outlined"
                              color="error"
                              sx={{ textTransform: 'none', minWidth: 50, fontSize: '0.75rem' }}
                              onClick={() => deleteAddon(addon._id, app._id)}
                            >
                              Delete
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Box>
            </Box>
          )}
        </AccordionDetails>
      </Accordion>
    );
  };

  return (
    <Box>
      {/* Lorenco apps */}
      {lorencoApps.length > 0 && (
        <>
          <Typography variant="subtitle2" fontWeight={700} color="text.secondary"
            sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: 1, fontSize: '0.75rem' }}>
            Lorenco Apps
          </Typography>
          {lorencoApps.map(renderApp)}
        </>
      )}

      {/* Other apps */}
      {otherApps.length > 0 && (
        <>
          <Typography variant="subtitle2" fontWeight={700} color="text.secondary"
            sx={{ mt: 3, mb: 1.5, textTransform: 'uppercase', letterSpacing: 1, fontSize: '0.75rem' }}>
            Other Apps
          </Typography>
          {otherApps.map(renderApp)}
        </>
      )}

      {/* Package dialog */}
      <PackageDialog
        open={pkgDialog.open}
        pkg={pkgDialog.pkg}
        appId={pkgDialog.appId}
        onClose={() => setPkgDialog({ open: false, appId: null, pkg: null })}
        onSaved={() => { if (pkgDialog.appId) reloadAppData(pkgDialog.appId); }}
      />

      {/* Addon dialog */}
      <AddonDialog
        open={addonDialog.open}
        addon={addonDialog.addon}
        appId={addonDialog.appId}
        onClose={() => setAddonDialog({ open: false, appId: null, addon: null })}
        onSaved={() => { if (addonDialog.appId) reloadAppData(addonDialog.appId); }}
      />
    </Box>
  );
}

export default AppManagement;
