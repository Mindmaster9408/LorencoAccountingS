# User Access Control System

> **Unified modal-based access control for the Lorenco ecosystem**
> Last updated: March 2026

## Overview

The user access control system manages three layers of permissions for users within accounting practices:

1. **Role Layer** — User's capability level within the practice
2. **App Access Layer** — Which ecosystem apps the user can access
3. **Client Access Layer** — Which clients/companies the user can see

All three layers use a consistent modal interface pattern for configuration.

## Architecture

### Three-Layer Permission Model

```
┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐
│   ROLE LAYER    │    │  APP ACCESS      │    │  CLIENT ACCESS     │
│                 │    │  LAYER          │    │  LAYER            │
│ • business_owner│ -> │ • All apps      │ -> │ • All clients     │
│ • accountant    │    │ • pos           │    │ • Specific clients│
│ • store_manager │    │ • payroll       │    │ • No clients      │
│ • payroll_admin │    │ • accounting    │    │                   │
│ • assistant_mgr │    │ • sean          │    │                   │
│ • cashier       │    │ • coaching      │    │                   │
│ • trainee       │    │ • No apps       │    │                   │
└─────────────────┘    └──────────────────┘    └────────────────────┘
```

### Data Storage Model

#### Apps Access
- **`null`** = Unrestricted (access all apps)
- **`[]`** = No app access
- **`[app1, app2]`** = Specific apps only

#### Client Access
- **`null`** = Unrestricted (access all clients)
- **`[]`** = No client access
- **`[clientId1, clientId2]`** = Specific clients only

#### Role Access
- **Single string value** = `business_owner`, `accountant`, etc.

## Modal Interface Pattern

All three access types follow the same consistent modal design:

### Common Elements
- **Header**: `[Type] Access — [User Name]`
- **Description**: Explains the access type and current state
- **Selection Area**: Checkboxes (Apps/Clients) or Radio buttons (Roles)
- **Actions**: Save button + Cancel button

### Apps Access Modal

**Trigger**: Click "Apps" button on user card

**Features**:
- "All apps (unrestricted)" toggle at top
- Dynamic app list from `APP_DEFS` registry
- Individual app checkboxes (disabled when unrestricted)
- Apps show name, subtitle, and description

**Data Source**: `APP_DEFS` constant (dynamic — automatically includes new apps)

### Role Access Modal

**Trigger**: Click "Role" button on user card

**Features**:
- Radio button selection (single role only)
- Role hierarchy with descriptions
- Color-coded roles via `ROLE_COLORS`
- Current role highlighted

**Data Source**: `ROLE_DEFINITIONS` array derived from `ROLE_COLORS`

### Client Access Modal

**Trigger**: Click "Clients" button on user card

**Features**:
- "All clients (unrestricted)" toggle at top
- Dynamic client list from practice API
- Individual client checkboxes (disabled when unrestricted)
- Client cards show name and email

**Data Source**: `/api/eco-clients` endpoint (dynamic)

## Technical Implementation

### API Endpoints

| Access Type | Endpoint | Method | Body |
|-------------|----------|---------|------|
| Apps | `/api/users/${userId}` | `PUT` | `{ apps: null \| string[] }` |
| Role | `/api/users/${userId}` | `PUT` | `{ role: string }` |
| Clients | `/api/users/${userId}/client-access` | `PUT` | `{ clients: null \| number[] }` |

### Frontend Functions

| Function | Purpose |
|----------|---------|
| `changeUserApps(userId, name, currentApps)` | Open Apps access modal |
| `saveUserApps(userId, name)` | Submit Apps access changes |
| `changeUserRole(userId, name)` | Open Role access modal |
| `saveUserRole(userId, name)` | Submit Role changes |
| `changeUserClients(userId, name, currentClients)` | Open Client access modal |
| `saveUserClients(userId, name)` | Submit Client access changes |

### Dynamic Data Sources

The system automatically adapts to changes in:

- **App Registry** (`APP_DEFS`) — New apps appear automatically in Apps modal
- **Role Definitions** (`ROLE_COLORS`) — New roles appear automatically in Role modal
- **Practice Clients** (API) — Client list updates dynamically

## Permission Logic Rules

### Interaction Between Layers

1. **Role defines capability level** — What the user can do within allowed apps/clients
2. **App access defines visibility** — Which apps appear in the user's interface
3. **Client access defines scope** — Which companies/clients the user may see

### Unrestricted vs Restricted

#### Unrestricted (null values)
- User has access to all items in that category
- Individual selections are ignored
- Checkbox list is disabled in UI

#### Restricted (array values)
- User has access only to specified items
- Empty array = no access
- Individual checkboxes are enabled in UI

### Role-Based Permissions

Certain operations require minimum role levels:
- **Business Owners** can manage all users and settings
- **Accountants** can manage assigned clients
- **Store Managers** can manage store operations
- **Payroll Admins** can process payrolls
- Lower roles have view/limited edit access

## UI/UX Guidelines

### Visual Consistency

All modals use identical:
- **Modal size**: `max-width: 480px`, `width: 90%`
- **Background**: `#1a1a2e` with dark overlay
- **Border**: `1px solid rgba(255,255,255,0.1)`
- **Border radius**: `16px`
- **Padding**: `28px`

### Interactive States

- **Hover effects** on selectable items
- **Disabled state** when unrestricted toggle is active
- **Color coding** for roles and apps
- **Loading states** during saves

### Accessibility

- Proper `label` associations for all inputs
- Keyboard navigation support
- Screen reader friendly descriptions
- High contrast colors

## Backward Compatibility

### Preserved Behaviors

- Storage format unchanged (null/array patterns)
- API endpoints unchanged
- Permission logic unchanged
- Existing user access preserved

### Migration Path

The new modal system:
- ✅ **Replaces** browser `prompt()` dialogs
- ✅ **Preserves** all existing permission data
- ✅ **Maintains** same API contracts
- ✅ **Adds** better UX without breaking changes

## Testing Requirements

### User Scenarios
- [ ] User with unrestricted apps access
- [ ] User with specific apps only
- [ ] User with unrestricted client access
- [ ] User with specific clients only
- [ ] User role changes (all combinations)
- [ ] User losing access to an app (app removed from selection)
- [ ] User gaining access to an app (app added to selection)

### Dynamic Behavior
- [ ] New app added to `APP_DEFS` → appears in Apps modal automatically
- [ ] New role added to `ROLE_COLORS` → appears in Role modal automatically
- [ ] New client added to practice → appears in Client modal automatically

### Error Handling
- [ ] API failures display proper error messages
- [ ] Network issues don't break modal state
- [ ] Invalid selections are prevented/corrected
- [ ] Cancel operations don't save partial changes

## Security Considerations

### Input Validation
- Apps must exist in `APP_DEFS` registry
- Roles must exist in `ROLE_COLORS` definition
- Client IDs must be valid practice clients
- User cannot modify their own permissions (except in specific cases)

### Authorization
- Only business owners and authorized roles can modify user access
- Users cannot escalate their own privileges
- Soft-delete pattern prevents accidental permanent access loss

## Future Extensibility

### Adding New Apps
1. Add app definition to `APP_DEFS`
2. App automatically appears in access modals
3. No code changes needed in access control system

### Adding New Roles
1. Add role to `ROLE_COLORS` definition
2. Role automatically appears in role modal
3. Update role hierarchy/descriptions as needed

### Adding New Access Types
The modal pattern can be extended for additional access dimensions:
- Department access
- Feature flags access
- Geographic regions access
- Time-based access rules

## Migration Notes

### Removed Components
- ❌ Browser `prompt()` dialogs for apps
- ❌ Browser `prompt()` dialogs for roles
- ❌ Hardcoded `ALL_APPS` array
- ❌ Hardcoded `validRoles` array

### Added Components
- ✅ `changeUserApps()` — Apps access modal
- ✅ `saveUserApps()` — Apps access save handler
- ✅ `changeUserRole()` — Role access modal
- ✅ `saveUserRole()` — Role access save handler
- ✅ Dynamic data source integration
- ✅ Consistent modal UI system

---

*This system provides a unified, maintainable, and user-friendly approach to managing access control across the entire Lorenco ecosystem.*