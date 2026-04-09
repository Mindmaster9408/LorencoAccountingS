# SAVE INSTRUCTIONS: Lorenco Logo PNG Files

**Date:** April 2026

---

## Your Approved PNG Images

You provided two approved PNG reference images showing the exact neon circuit logo visual style:

1. **Full reference artwork** — Shows complete neon circuit with all glow layers
2. **Tighter crop version** — App-ready cropped for UI placement

---

## Where to Save These Files

### From the images you provided, save as:

1. **Full reference:**
   ```
   Save as: lorenco-logo-exact-reference.png
   Location: /root-of-workspace/
   Purpose: Master visual reference for consistency
   ```

2. **App-ready cropped:**
   ```
   Save as: lorenco-logo-cropped.png
   Location: /root-of-workspace/
   Purpose: Use for login screens and branding
   ```

### Then copy the cropped version to each frontend:

```bash
# After saving lorenco-logo-cropped.png to workspace root:

cp lorenco-logo-cropped.png accounting-ecosystem/frontend-ecosystem/
cp lorenco-logo-cropped.png accounting-ecosystem/frontend-payroll/
cp lorenco-logo-cropped.png accounting-ecosystem/frontend-coaching/
```

---

## File Storage Map

```
Workspace Root
├── lorenco-logo-exact-reference.png       (master reference)
├── lorenco-logo-cropped.png               (master copy)
│
└── accounting-ecosystem/
    ├── frontend-ecosystem/
    │   ├── login.html
    │   └── lorenco-logo-cropped.png       (copy → served as static)
    ├── frontend-payroll/
    │   ├── login.html
    │   └── lorenco-logo-cropped.png       (copy → served as static)
    └── frontend-coaching/
        ├── login.html
        └── lorenco-logo-cropped.png       (copy → served as static)
```

---

## HTML Usage

Once files are in place, reference in login pages:

```html
<img 
  src="/lorenco-logo-cropped.png" 
  alt="Lorenco Ecosystem" 
  className="w-44 h-auto"
/>
```

---

## Next Steps

1. Save your provided PNG images as `lorenco-logo-exact-reference.png` and `lorenco-logo-cropped.png` to workspace root
2. Copy `lorenco-logo-cropped.png` to each frontend directory
3. Update login.html files to use `<img>` tags instead of inline SVG
4. Test on each app's login page

---

*Reference the approved PNG files you provided for exact visual style.*
