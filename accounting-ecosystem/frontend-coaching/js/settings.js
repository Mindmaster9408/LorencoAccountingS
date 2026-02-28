// Settings Module - Company details, report templates, and app configuration
import { $, escapeHtml } from './config.js';
import { readStore, writeStore } from './storage.js';

let currentSettings = null;

export async function renderSettings() {
    const view = $('#settings');
    if (!view) return;

    const store = await readStore();

    // Initialize settings if not exists
    if (!store.appSettings) {
        store.appSettings = {
            company: {
                name: 'The Neuro-Coach Method',
                logo: '',
                primaryColor: '#3b82f6',
                secondaryColor: '#8b5cf6',
                accentColor: '#ec4899'
            },
            reportTemplates: {
                basisReport: {
                    headerText: 'BASIS Assessment Report',
                    footerText: '© {year} {companyName}. All rights reserved.',
                    includeCoachName: true,
                    includeDate: true,
                    includePageNumbers: true
                },
                progressReport: {
                    headerText: 'Progress Report',
                    footerText: '© {year} {companyName}. Confidential.',
                    includeCoachName: true,
                    includeDate: true
                }
            }
        };
        await writeStore(store);
    }

    currentSettings = store.appSettings;

    view.innerHTML = `
        <div class="settings-container">
            <header class="settings-header">
                <h2>⚙️ Settings</h2>
                <p class="settings-subtitle">Configure company details, branding, and report templates</p>
            </header>

            <div class="settings-tabs">
                <button class="tab-btn active" data-tab="company">🏢 Company Details</button>
                <button class="tab-btn" data-tab="reports">📄 Report Templates</button>
                <button class="tab-btn" data-tab="branding">🎨 Branding & Colors</button>
            </div>

            <div class="settings-content">
                <!-- Company Details Tab -->
                <div class="tab-content active" id="company-tab">
                    <h3>Company Information</h3>
                    <p class="tab-description">This information will appear on reports and throughout the app</p>

                    <div class="form-group">
                        <label for="company-name">Company Name *</label>
                        <input
                            type="text"
                            id="company-name"
                            value="${escapeHtml(currentSettings.company.name)}"
                            placeholder="The Neuro-Coach Method"
                        />
                    </div>

                    <div class="form-group">
                        <label for="company-logo">Company Logo</label>
                        <div class="logo-upload-area" id="logo-drop-zone" ondrop="handleLogoDrop(event)" ondragover="handleLogoDragOver(event)" ondragleave="handleLogoDragLeave(event)" onclick="handleLogoAreaClick(event)">
                            ${currentSettings.company.logo ? `
                                <div class="logo-preview" id="logo-preview">
                                    <img src="${currentSettings.company.logo}" alt="Company Logo" id="logo-preview-img" />
                                    <button class="btn-remove-logo" onclick="event.stopPropagation(); removeCompanyLogo()">✕ Remove</button>
                                </div>
                            ` : `
                                <div class="logo-placeholder" id="logo-placeholder">
                                    <span>📷</span>
                                    <p>Drag & drop your logo here</p>
                                    <p style="font-size: 14px; color: #94a3b8; margin-top: 8px;">or click to browse</p>
                                </div>
                            `}
                            <input
                                type="file"
                                id="company-logo"
                                accept="image/*"
                                style="display: none;"
                                onchange="handleLogoUpload(event)"
                            />
                            <button class="btn-upload" onclick="$('#company-logo').click()" style="${currentSettings.company.logo ? 'display: none;' : ''}">
                                📁 Choose Logo File
                            </button>
                            <p class="help-text">Recommended: PNG or SVG, max 2MB, transparent background</p>
                        </div>
                    </div>
                </div>

                <!-- Report Templates Tab -->
                <div class="tab-content" id="reports-tab">
                    <h3>Report Templates</h3>
                    <p class="tab-description">Customize headers, footers, and content for each report type</p>

                    <div class="template-section">
                        <h4>BASIS Assessment Report</h4>

                        <div class="form-group">
                            <label for="basis-header">Header Text</label>
                            <input
                                type="text"
                                id="basis-header"
                                value="${escapeHtml(currentSettings.reportTemplates.basisReport.headerText)}"
                                placeholder="BASIS Assessment Report"
                            />
                        </div>

                        <div class="form-group">
                            <label for="basis-footer">Footer Text</label>
                            <input
                                type="text"
                                id="basis-footer"
                                value="${escapeHtml(currentSettings.reportTemplates.basisReport.footerText)}"
                                placeholder="© {year} {companyName}"
                            />
                            <p class="help-text">Use {year} for current year, {companyName} for company name, {coachName} for coach name</p>
                        </div>

                        <div class="form-group-inline">
                            <label class="checkbox-label">
                                <input
                                    type="checkbox"
                                    id="basis-include-coach"
                                    ${currentSettings.reportTemplates.basisReport.includeCoachName ? 'checked' : ''}
                                />
                                Include Coach Name
                            </label>

                            <label class="checkbox-label">
                                <input
                                    type="checkbox"
                                    id="basis-include-date"
                                    ${currentSettings.reportTemplates.basisReport.includeDate ? 'checked' : ''}
                                />
                                Include Date
                            </label>

                            <label class="checkbox-label">
                                <input
                                    type="checkbox"
                                    id="basis-include-pages"
                                    ${currentSettings.reportTemplates.basisReport.includePageNumbers ? 'checked' : ''}
                                />
                                Include Page Numbers
                            </label>
                        </div>
                    </div>

                    <div class="template-section">
                        <h4>Progress Report</h4>

                        <div class="form-group">
                            <label for="progress-header">Header Text</label>
                            <input
                                type="text"
                                id="progress-header"
                                value="${escapeHtml(currentSettings.reportTemplates.progressReport.headerText)}"
                                placeholder="Progress Report"
                            />
                        </div>

                        <div class="form-group">
                            <label for="progress-footer">Footer Text</label>
                            <input
                                type="text"
                                id="progress-footer"
                                value="${escapeHtml(currentSettings.reportTemplates.progressReport.footerText)}"
                                placeholder="© {year} {companyName}"
                            />
                        </div>

                        <div class="form-group-inline">
                            <label class="checkbox-label">
                                <input
                                    type="checkbox"
                                    id="progress-include-coach"
                                    ${currentSettings.reportTemplates.progressReport.includeCoachName ? 'checked' : ''}
                                />
                                Include Coach Name
                            </label>

                            <label class="checkbox-label">
                                <input
                                    type="checkbox"
                                    id="progress-include-date"
                                    ${currentSettings.reportTemplates.progressReport.includeDate ? 'checked' : ''}
                                />
                                Include Date
                            </label>
                        </div>
                    </div>

                    <div class="template-actions-section">
                        <h4>Template Management</h4>
                        <p class="help-text">Download your current template as HTML, edit it, and upload the modified version</p>

                        <div class="template-buttons">
                            <button class="btn-preview-template" onclick="previewReportTemplate('basis')">
                                👁️ Preview BASIS Template
                            </button>
                            <button class="btn-download-template" onclick="downloadReportTemplate('basis')">
                                📥 Download BASIS Template (HTML)
                            </button>
                            <div class="upload-template-wrapper">
                                <input type="file" id="upload-basis-template" accept=".html" style="display: none;" onchange="uploadReportTemplate(event, 'basis')" />
                                <button class="btn-upload-template" onclick="$('#upload-basis-template').click()">
                                    📤 Upload Modified BASIS Template
                                </button>
                            </div>
                        </div>

                        <div class="template-buttons" style="margin-top: 20px;">
                            <button class="btn-preview-template" onclick="previewReportTemplate('progress')">
                                👁️ Preview Progress Template
                            </button>
                            <button class="btn-download-template" onclick="downloadReportTemplate('progress')">
                                📥 Download Progress Template (HTML)
                            </button>
                            <div class="upload-template-wrapper">
                                <input type="file" id="upload-progress-template" accept=".html" style="display: none;" onchange="uploadReportTemplate(event, 'progress')" />
                                <button class="btn-upload-template" onclick="$('#upload-progress-template').click()">
                                    📤 Upload Modified Progress Template
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Branding & Colors Tab -->
                <div class="tab-content" id="branding-tab">
                    <h3>Branding & Color Scheme</h3>
                    <p class="tab-description">Customize colors used in reports and the dashboard</p>

                    <div class="color-picker-group">
                        <div class="color-picker-item">
                            <label for="primary-color">Primary Color (Phase 1)</label>
                            <div class="color-input-wrapper">
                                <input
                                    type="color"
                                    id="primary-color"
                                    value="${currentSettings.company.primaryColor}"
                                />
                                <input
                                    type="text"
                                    id="primary-color-text"
                                    value="${currentSettings.company.primaryColor}"
                                    pattern="^#[0-9A-Fa-f]{6}$"
                                />
                            </div>
                            <div class="color-preview" style="background: ${currentSettings.company.primaryColor};"></div>
                        </div>

                        <div class="color-picker-item">
                            <label for="secondary-color">Secondary Color (Phase 2)</label>
                            <div class="color-input-wrapper">
                                <input
                                    type="color"
                                    id="secondary-color"
                                    value="${currentSettings.company.secondaryColor}"
                                />
                                <input
                                    type="text"
                                    id="secondary-color-text"
                                    value="${currentSettings.company.secondaryColor}"
                                    pattern="^#[0-9A-Fa-f]{6}$"
                                />
                            </div>
                            <div class="color-preview" style="background: ${currentSettings.company.secondaryColor};"></div>
                        </div>

                        <div class="color-picker-item">
                            <label for="accent-color">Accent Color (Phase 3)</label>
                            <div class="color-input-wrapper">
                                <input
                                    type="color"
                                    id="accent-color"
                                    value="${currentSettings.company.accentColor}"
                                />
                                <input
                                    type="text"
                                    id="accent-color-text"
                                    value="${currentSettings.company.accentColor}"
                                    pattern="^#[0-9A-Fa-f]{6}$"
                                />
                            </div>
                            <div class="color-preview" style="background: ${currentSettings.company.accentColor};"></div>
                        </div>
                    </div>

                    <div class="preview-section">
                        <h4>Preview</h4>
                        <div class="phase-preview">
                            <div class="phase-card" style="border-color: ${currentSettings.company.primaryColor};">
                                <div class="phase-dot" style="background: ${currentSettings.company.primaryColor};"></div>
                                <span>Phase 1</span>
                            </div>
                            <div class="phase-card" style="border-color: ${currentSettings.company.secondaryColor};">
                                <div class="phase-dot" style="background: ${currentSettings.company.secondaryColor};"></div>
                                <span>Phase 2</span>
                            </div>
                            <div class="phase-card" style="border-color: ${currentSettings.company.accentColor};">
                                <div class="phase-dot" style="background: ${currentSettings.company.accentColor};"></div>
                                <span>Phase 3</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="settings-actions">
                <button class="btn-save-settings" onclick="saveAllSettings()">
                    💾 Save All Settings
                </button>
                <button class="btn-reset-settings" onclick="resetToDefaults()">
                    🔄 Reset to Defaults
                </button>
            </div>
        </div>
    `;

    attachSettingsListeners();
}

function attachSettingsListeners() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;

            // Update active states
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            $(`#${tabName}-tab`)?.classList.add('active');
        });
    });

    // Color picker sync
    ['primary', 'secondary', 'accent'].forEach(colorType => {
        const colorPicker = $(`#${colorType}-color`);
        const colorText = $(`#${colorType}-color-text`);

        if (colorPicker && colorText) {
            colorPicker.addEventListener('input', (e) => {
                colorText.value = e.target.value;
                updateColorPreview(colorType, e.target.value);
            });

            colorText.addEventListener('input', (e) => {
                if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) {
                    colorPicker.value = e.target.value;
                    updateColorPreview(colorType, e.target.value);
                }
            });
        }
    });
}

function updateColorPreview(colorType, color) {
    const preview = document.querySelector(`#${colorType}-color`).closest('.color-picker-item').querySelector('.color-preview');
    if (preview) {
        preview.style.background = color;
    }

    // Update phase preview
    const phaseIndex = colorType === 'primary' ? 0 : colorType === 'secondary' ? 1 : 2;
    const phaseCards = document.querySelectorAll('.phase-card');
    if (phaseCards[phaseIndex]) {
        phaseCards[phaseIndex].style.borderColor = color;
        const dot = phaseCards[phaseIndex].querySelector('.phase-dot');
        if (dot) dot.style.background = color;
    }
}

window.handleLogoAreaClick = function(event) {
    // Don't trigger if clicking on remove button or if logo already exists
    if (event.target.classList.contains('btn-remove-logo')) return;
    if (currentSettings.company.logo) return;

    const fileInput = $('#company-logo');
    if (fileInput) fileInput.click();
};

window.handleLogoUpload = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    processLogoFile(file);
};

window.handleLogoDrop = function(event) {
    event.preventDefault();
    event.stopPropagation();

    const dropZone = $('#logo-drop-zone');
    if (dropZone) dropZone.classList.remove('drag-over');

    const file = event.dataTransfer.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        alert('Please drop an image file (PNG, JPG, SVG, etc.)');
        return;
    }

    processLogoFile(file);
};

window.handleLogoDragOver = function(event) {
    event.preventDefault();
    event.stopPropagation();
    const dropZone = $('#logo-drop-zone');
    if (dropZone) dropZone.classList.add('drag-over');
};

window.handleLogoDragLeave = function(event) {
    event.preventDefault();
    const dropZone = $('#logo-drop-zone');
    if (dropZone) dropZone.classList.remove('drag-over');
};

function processLogoFile(file) {
    if (file.size > 2 * 1024 * 1024) {
        alert('Logo file is too large. Maximum size is 2MB.');
        return;
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        currentSettings.company.logo = e.target.result;

        // Update preview without full re-render
        const placeholder = $('#logo-placeholder');
        const uploadBtn = document.querySelector('.logo-upload-area .btn-upload');
        const dropZone = $('#logo-drop-zone');

        if (placeholder) {
            placeholder.remove();
        }

        if (uploadBtn) {
            uploadBtn.style.display = 'none';
        }

        // Create or update preview
        let preview = $('#logo-preview');
        if (!preview) {
            preview = document.createElement('div');
            preview.className = 'logo-preview';
            preview.id = 'logo-preview';
            dropZone.insertBefore(preview, dropZone.firstChild);
        }

        preview.innerHTML = `
            <img src="${e.target.result}" alt="Company Logo" id="logo-preview-img" />
            <button class="btn-remove-logo" onclick="removeCompanyLogo()">✕ Remove</button>
        `;

        alert('✓ Logo uploaded! Click "Save All Settings" to save permanently.');
    };
    reader.readAsDataURL(file);
}

window.removeCompanyLogo = async function() {
    if (!confirm('Remove company logo?')) return;

    currentSettings.company.logo = '';

    const store = await readStore();
    store.appSettings.company.logo = '';
    await writeStore(store);

    // Re-render to show placeholder
    renderSettings();
    alert('Logo removed.');
};

window.saveAllSettings = async function() {
    const store = await readStore();

    // Collect all settings
    store.appSettings = {
        company: {
            name: $('#company-name')?.value || 'The Neuro-Coach Method',
            logo: currentSettings.company.logo,
            primaryColor: $('#primary-color')?.value || '#3b82f6',
            secondaryColor: $('#secondary-color')?.value || '#8b5cf6',
            accentColor: $('#accent-color')?.value || '#ec4899'
        },
        reportTemplates: {
            basisReport: {
                headerText: $('#basis-header')?.value || 'BASIS Assessment Report',
                footerText: $('#basis-footer')?.value || '© {year} {companyName}',
                includeCoachName: $('#basis-include-coach')?.checked || false,
                includeDate: $('#basis-include-date')?.checked || false,
                includePageNumbers: $('#basis-include-pages')?.checked || false
            },
            progressReport: {
                headerText: $('#progress-header')?.value || 'Progress Report',
                footerText: $('#progress-footer')?.value || '© {year} {companyName}',
                includeCoachName: $('#progress-include-coach')?.checked || false,
                includeDate: $('#progress-include-date')?.checked || false
            }
        }
    };

    await writeStore(store);

    // Update branding in main app
    if (window.updateCompanyBranding) {
        window.updateCompanyBranding();
    }

    alert('✓ Settings saved successfully!');
};

window.resetToDefaults = function() {
    if (!confirm('Are you sure you want to reset all settings to defaults? This cannot be undone.')) {
        return;
    }

    currentSettings = {
        company: {
            name: 'The Neuro-Coach Method',
            logo: '',
            primaryColor: '#3b82f6',
            secondaryColor: '#8b5cf6',
            accentColor: '#ec4899'
        },
        reportTemplates: {
            basisReport: {
                headerText: 'BASIS Assessment Report',
                footerText: '© {year} {companyName}. All rights reserved.',
                includeCoachName: true,
                includeDate: true,
                includePageNumbers: true
            },
            progressReport: {
                headerText: 'Progress Report',
                footerText: '© {year} {companyName}. Confidential.',
                includeCoachName: true,
                includeDate: true
            }
        }
    };

    renderSettings();
    alert('Settings reset to defaults. Click "Save All Settings" to apply.');
};

// Template management functions - temporary file to append to settings.js

// ===== REPORT TEMPLATE MANAGEMENT =====

window.previewReportTemplate = async function(templateType) {
    const store = await readStore();
    const settings = store.appSettings || currentSettings;

    // Check if custom template exists
    const customTemplate = settings.reportTemplates[templateType === 'basis' ? 'basisReport' : 'progressReport'].customTemplate;

    if (customTemplate) {
        // Preview custom template
        const previewWindow = window.open('', '_blank');
        previewWindow.document.write(customTemplate);
        previewWindow.document.close();
    } else {
        // Generate default template preview
        const template = generateDefaultTemplate(templateType, settings);
        const previewWindow = window.open('', '_blank');
        previewWindow.document.write(template);
        previewWindow.document.close();
    }
};

window.downloadReportTemplate = async function(templateType) {
    const store = await readStore();
    const settings = store.appSettings || currentSettings;

    // Check if custom template exists, otherwise generate default
    let template;
    const customTemplate = settings.reportTemplates[templateType === 'basis' ? 'basisReport' : 'progressReport'].customTemplate;

    if (customTemplate) {
        template = customTemplate;
    } else {
        template = generateDefaultTemplate(templateType, settings);
    }

    // Download as HTML file
    const blob = new Blob([template], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${templateType}-report-template.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    alert(`✓ Template downloaded as ${templateType}-report-template.html\n\nYou can now edit this HTML file and upload it back.`);
};

window.uploadReportTemplate = async function(event, templateType) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.html')) {
        alert('Please upload an HTML file (.html)');
        return;
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        const templateContent = e.target.result;

        // Validate it's HTML
        if (!templateContent.includes('<html') && !templateContent.includes('<HTML')) {
            alert('Invalid HTML template. Please ensure the file contains valid HTML.');
            return;
        }

        const store = await readStore();

        // Save custom template
        const reportKey = templateType === 'basis' ? 'basisReport' : 'progressReport';
        store.appSettings.reportTemplates[reportKey].customTemplate = templateContent;

        await writeStore(store);
        currentSettings = store.appSettings;

        alert(`✓ Custom ${templateType} template uploaded successfully!\n\nYour custom template will now be used for all ${templateType} reports.`);
    };

    reader.readAsText(file);
};

function generateDefaultTemplate(templateType, settings) {
    const company = settings.company;
    const template = settings.reportTemplates[templateType === 'basis' ? 'basisReport' : 'progressReport'];

    const currentYear = new Date().getFullYear();
    const headerText = template.headerText;
    const footerText = template.footerText
        .replace('{year}', currentYear)
        .replace('{companyName}', company.name)
        .replace('{coachName}', '[Coach Name]');

    if (templateType === 'basis') {
        return generateBASISTemplate(headerText, footerText, company, template);
    } else {
        return generateProgressTemplate(headerText, footerText, company, template);
    }
}

function generateBASISTemplate(headerText, footerText, company, template) {
    const primaryColor = company.primaryColor || '#3b82f6';
    const secondaryColor = company.secondaryColor || '#8b5cf6';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${headerText}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        .header {
            text-align: center;
            padding: 30px 0;
            border-bottom: 3px solid ${primaryColor};
            margin-bottom: 40px;
        }
        .logo { max-width: 200px; margin-bottom: 20px; }
        h1 { color: ${primaryColor}; font-size: 36px; margin-bottom: 10px; }
        .subtitle { color: #64748b; font-size: 18px; }
        .report-date {
            text-align: right;
            color: #64748b;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .coach-info {
            background: #f8fafc;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 30px;
        }
        .client-info {
            background: linear-gradient(135deg, ${primaryColor} 0%, ${secondaryColor} 100%);
            color: white;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 40px;
        }
        .section { margin-bottom: 40px; }
        .section-title {
            color: ${primaryColor};
            font-size: 24px;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e2e8f0;
        }
        .basis-code {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin: 30px 0;
        }
        .basis-letter {
            background: linear-gradient(135deg, ${primaryColor} 0%, ${secondaryColor} 100%);
            color: white;
            width: 80px;
            height: 80px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            font-weight: 700;
            border-radius: 12px;
        }
        .description {
            background: #f8fafc;
            padding: 20px;
            border-radius: 8px;
            margin: 10px 0;
        }
        .gauge-section {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
        }
        .gauge-item {
            background: white;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
        }
        .footer {
            text-align: center;
            margin-top: 60px;
            padding-top: 30px;
            border-top: 2px solid #e2e8f0;
            color: #64748b;
        }
    </style>
</head>
<body>
    <div class="header">
        ${company.logo ? `<img src="${company.logo}" alt="${company.name}" class="logo" />` : ''}
        <h1>${headerText}</h1>
        <div class="subtitle">Comprehensive Assessment Report</div>
    </div>

    ${template.includeDate ? '<div class="report-date">Date: [Report Date]</div>' : ''}

    ${template.includeCoachName ? `<div class="coach-info"><strong>Coach:</strong> [Coach Name]</div>` : ''}

    <div class="client-info">
        <div style="font-size: 28px; font-weight: 700;">[Client Name]</div>
        <div>Email: [Client Email] | Phone: [Client Phone]</div>
    </div>

    <div class="section">
        <h2 class="section-title">BASIS Code</h2>
        <div class="basis-code">
            <div class="basis-letter">B</div>
            <div class="basis-letter">E</div>
            <div class="basis-letter">S</div>
            <div class="basis-letter">T</div>
        </div>
    </div>

    <div class="section">
        <h2 class="section-title">Assessment Scores</h2>
        <div class="gauge-section">
            <div class="gauge-item">
                <div>Positive Psycho-social</div>
                <div style="font-size: 32px; font-weight: 700;">[Score]</div>
            </div>
            <div class="gauge-item">
                <div>Emotional Functioning</div>
                <div style="font-size: 32px; font-weight: 700;">[Score]</div>
            </div>
        </div>
    </div>

    <div class="footer">${footerText}</div>
</body>
</html>`;
}

function generateProgressTemplate(headerText, footerText, company, template) {
    const secondaryColor = company.secondaryColor || '#8b5cf6';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${headerText}</title>
    <style>
        body {
            font-family: 'Segoe UI', sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        .header {
            text-align: center;
            padding: 30px 0;
            border-bottom: 3px solid ${secondaryColor};
            margin-bottom: 40px;
        }
        h1 { color: ${secondaryColor}; }
        .footer {
            text-align: center;
            margin-top: 60px;
            padding-top: 30px;
            border-top: 2px solid #e2e8f0;
        }
    </style>
</head>
<body>
    <div class="header">
        ${company.logo ? `<img src="${company.logo}" style="max-width: 200px;" />` : ''}
        <h1>${headerText}</h1>
    </div>
    <div class="footer">${footerText}</div>
</body>
</html>`;
}

