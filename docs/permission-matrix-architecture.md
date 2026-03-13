# Permission Matrix Architecture

> **Visual permission management system for the Lorenco ecosystem**
> Last updated: March 2026

## Overview

The Permission Matrix system provides a scalable, visual approach to managing user access control across the Lorenco ecosystem. It replaces individual modal-only management with a comprehensive matrix view that supports large teams and client lists.

## Architecture Principles

### **Three-Layer Permission Model**

```
┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐
│   ROLE LAYER    │    │  APP ACCESS      │    │  CLIENT ACCESS     │
│                 │    │  LAYER          │    │  LAYER            │
│ Single role     │ +  │ null = All apps │ +  │ null = All clients│
│ per user        │    │ [] = Specific   │    │ [] = Specific     │
└─────────────────┘    └──────────────────┘    └────────────────────┘
                                ↓
                    ┌─────────────────────────┐
                    │   EFFECTIVE ACCESS      │
                    │   User can access:      │
                    │   Apps ∩ Clients        │
                    │   within Role limits    │
                    └─────────────────────────┘
```

### **Matrix + Modal Hybrid Design**

The system uses a **matrix-primary** approach:
- ✅ **Matrix View**: Main management interface for bulk visibility and quick edits
- ✅ **Detail Modals**: Advanced editing and complex permission changes

## Three-Tab Structure

### **Tab 1: Overview**
- **Purpose**: High-level permission summary and user overview
- **Content**:
  - Permission statistics (total users, unrestricted users, active apps, total clients)
  - User summary table with role, app/client counts, restriction status
- **Use Case**: Quick practice-wide permission audit

### **Tab 2: Apps Matrix**
- **Purpose**: User × Apps permission grid
- **Content**:
  - Dynamic columns for each app in `APP_DEFS`
  - Clickable cells for inline permission toggles
  - Sticky user column for large app lists
- **Use Case**: "Who has access to which apps?"

### **Tab 3: Clients Matrix**
- **Purpose**: User × Clients permission grid
- **Content**:
  - Dynamic columns for each client in practice
  - Clickable cells for inline client access toggles
  - Horizontal scroll with sticky user column
- **Use Case**: "Who can access which clients?"

## Data Sources

### **Users Data**
- **Source**: `/api/users`
- **Structure**:
  ```javascript
  {
    id: number,
    full_name: string,
    username: string,
    email: string,
    role: string,
    apps: string[] | null,    // null = unrestricted
    clients: number[] | null  // null = unrestricted
  }
  ```

### **Apps Registry**
- **Source**: `APP_DEFS` constant (frontend)
- **Structure**:
  ```javascript
  {
    key: string,      // 'pos', 'payroll', 'accounting', 'sean', 'coaching'
    name: string,     // Display name
    subtitle: string, // App category
    icon: string,     // Unicode icon
    desc: string      // Description
  }
  ```

### **Clients Data**
- **Source**: `/api/eco-clients`
- **Structure**:
  ```javascript
  {
    id: number,
    name: string,
    email: string,
    // ... other client fields
  }
  ```

### **Roles Registry**
- **Source**: `ROLE_DEFINITIONS` + `ROLE_COLORS` constants
- **Supported Roles**: business_owner, accountant, store_manager, payroll_admin, assistant_manager, cashier, trainee

## Permission Storage Logic

### **Database Tables**
1. **`user_company_access`** - User membership + role in company
2. **`user_app_access`** - Specific app restrictions (presence = restriction)
3. **`user_client_access`** - Specific client restrictions (presence = restriction)

### **Backend Logic**
```javascript
// Apps Permission Logic
if (no records in user_app_access for user) {
  apps = null; // Unrestricted access to all apps
} else {
  apps = [app_keys]; // Restricted to specific apps
}

// Clients Permission Logic
if (no records in user_client_access for user) {
  clients = null; // Unrestricted access to all clients
} else {
  clients = [client_ids]; // Restricted to specific clients
}
```

### **Unrestricted vs Restricted Patterns**
- **Unrestricted**: `null` value means "access everything"
- **Restricted**: Array with specific IDs means "access only these"
- **No Access**: Empty array `[]` means "access nothing"

## Matrix Interaction Patterns

### **Inline Editing - Apps Matrix**
```javascript
// Click cell in Apps Matrix
toggleUserAppAccess(userId, appKey) {
  if (user.apps === null) {
    // Unrestricted user - open modal for complex editing
    changeUserApps(userId, userName, user.apps);
  } else {
    // Restricted user - toggle inline
    if (user.apps.includes(appKey)) {
      user.apps = user.apps.filter(a => a !== appKey); // Remove
    } else {
      user.apps = [...user.apps, appKey]; // Add
    }
    // Save via API and update UI
  }
}
```

### **Inline Editing - Clients Matrix**
```javascript
// Click cell in Clients Matrix
toggleUserClientAccess(userId, clientId) {
  if (user.clients === null) {
    // Unrestricted user - open modal for complex editing
    changeUserClients(userId, userName, user.clients);
  } else {
    // Restricted user - toggle inline
    if (user.clients.includes(clientId)) {
      user.clients = user.clients.filter(c => c !== clientId); // Remove
    } else {
      user.clients = [...user.clients, clientId]; // Add
    }
    // Save via API and update UI
  }
}
```

## UI Visual Language

### **Matrix Design**
- **Sticky Headers**: User column and role column remain visible during horizontal scroll
- **Hover States**: Row highlighting and cell hover effects
- **Access States**:
  - ✓ **Green checkmark**: Has access (restricted users)
  - ○ **Gray circle**: No access (restricted users)
  - **"All" badge**: Unrestricted access to everything

### **Overview Design**
- **Summary Cards**: Key statistics in grid layout
- **Status Badges**: "Unrestricted" vs "Restricted" user indicators
- **User Cards**: Avatar + name + email + role + access counts

### **Responsive Behavior**
- **Desktop**: Full matrix with sticky columns
- **Tablet**: Horizontal scroll with sticky user info
- **Mobile**: Falls back to modal-based editing for better UX

## Integration with Existing Modals

### **Modal System Preservation**
The matrix system **preserves and enhances** the existing modal system:

1. **Apps Modal**: Still available for advanced editing, bulk changes
2. **Role Modal**: Still available for role changes with descriptions
3. **Client Modal**: Still available for complex client access patterns

### **Matrix ↔ Modal Synchronization**
```javascript
// When modal saves data:
async function saveUserApps(userId, name) {
  // ... save via API ...

  // Sync with matrix if active
  if (currentMatrixTab && matrixUsers.length > 0) {
    const user = matrixUsers.find(u => u.id === parseInt(userId));
    if (user) {
      user.apps = apps; // Update local matrix data
      renderPermissionMatrix(); // Re-render matrix
    }
  }
}
```

## Performance Considerations

### **Data Loading Strategy**
- **Parallel Loading**: Users and clients loaded simultaneously
- **Matrix Caching**: Data cached locally until tab switch or explicit refresh
- **Incremental Updates**: Individual permission changes update local data immediately

### **Rendering Optimization**
- **Tab-Based Rendering**: Only active tab content is rendered
- **Sticky Columns**: Uses CSS `position: sticky` for performance
- **Virtual Scrolling**: Can be added for very large client lists (future enhancement)

### **API Efficiency**
- **Single User Endpoint**: Matrix loads from same `/api/users` as card view
- **Bulk Operations**: Individual cell clicks make single API calls
- **Optimistic Updates**: UI updates immediately, reverts on API failure

## Scalability Features

### **Dynamic Column Generation**
```javascript
// Apps columns generated from APP_DEFS
${APP_DEFS.map(app => `<th>${app.name}</th>`).join('')}

// Clients columns generated from API data
${matrixClients.map(client => `<th>${client.name}</th>`).join('')}
```

### **Future Extensibility**
- **New Apps**: Automatically appear in Apps Matrix when added to `APP_DEFS`
- **New Clients**: Automatically appear in Clients Matrix when added to practice
- **New Permission Dimensions**: Can add new matrix tabs (e.g., "Features Matrix", "Regions Matrix")

### **Large Dataset Support**
- **Horizontal Scroll**: Handles many apps/clients gracefully
- **Search/Filter**: Can be added to user rows for large teams
- **Pagination**: Can be added to matrix rows for very large practices

## Security Considerations

### **Permission Validation**
- **Frontend**: Matrix only shows users you can manage (based on security context)
- **Backend**: All API calls validate permission to modify target user
- **Role Hierarchy**: System respects role-based access controls

### **Data Integrity**
- **Optimistic Updates**: Failed API calls revert UI changes
- **Conflict Resolution**: Matrix refresh handles concurrent edits
- **Audit Trail**: All permission changes logged via existing audit system

## Testing Strategy

### **Matrix Functionality Tests**
- [ ] Overview tab renders correctly with all users
- [ ] Apps matrix displays all apps from `APP_DEFS`
- [ ] Clients matrix displays all clients from API
- [ ] Inline app access toggles work correctly
- [ ] Inline client access toggles work correctly
- [ ] Unrestricted users open modals instead of inline toggle

### **Integration Tests**
- [ ] Modal changes sync back to matrix view
- [ ] Tab switching preserves data state
- [ ] Permission changes persist after page refresh
- [ ] Matrix reflects backend permission enforcement

### **Scalability Tests**
- [ ] Matrix handles 50+ users gracefully
- [ ] Matrix handles 20+ apps without layout issues
- [ ] Matrix handles 100+ clients with horizontal scroll
- [ ] Performance acceptable with large datasets

## Future Enhancements

### **Phase 2 Features**
- **Search/Filter**: User search, role filter, access pattern filters
- **Bulk Operations**: Select multiple users for bulk permission changes
- **Export**: CSV export of permission matrix for auditing
- **Audit History**: View permission change history per user

### **Phase 3 Features**
- **Advanced Permissions**: Feature-level permissions within apps
- **Time-Based Access**: Temporary access grants with expiration
- **Approval Workflows**: Permission changes require approval for certain roles
- **Integration APIs**: Webhooks for external system synchronization

## Migration Notes

### **Backward Compatibility**
- ✅ All existing permission APIs unchanged
- ✅ Existing modal system fully preserved
- ✅ Database schema unchanged
- ✅ Permission enforcement logic unchanged

### **Deployment Strategy**
1. **Phase 1**: Deploy matrix alongside existing modals (feature flag)
2. **Phase 2**: Enable matrix by default, keep modals as fallback
3. **Phase 3**: Users can choose preferred interaction style

---

*The Permission Matrix provides a scalable foundation for access control management as the Lorenco ecosystem grows to support hundreds of users, dozens of apps, and thousands of clients.*