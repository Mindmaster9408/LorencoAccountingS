// ========== BULK IMPORT UTILITIES ==========
// Shared module for column mapping, validation, money parsing,
// period normalization, SA ID validation, and audit logging.

var BulkImportUtils = {

    // ========== COLUMN MAPPING ==========

    // Auto-map file headers to target fields using aliases
    autoMapColumns: function(fileHeaders, fieldAliases) {
        var mapping = {};
        var usedHeaders = {};
        Object.keys(fieldAliases).forEach(function(field) {
            var aliases = fieldAliases[field];
            for (var i = 0; i < fileHeaders.length; i++) {
                var header = fileHeaders[i].trim();
                if (usedHeaders[header]) continue;
                for (var j = 0; j < aliases.length; j++) {
                    if (header.toLowerCase() === aliases[j].toLowerCase()) {
                        mapping[field] = header;
                        usedHeaders[header] = true;
                        return;
                    }
                }
            }
        });
        return mapping;
    },

    // Get value from a row using the column mapping
    getMappedValue: function(row, field, mapping) {
        var col = mapping[field];
        if (!col) return null;
        var val = row[col];
        return (val !== undefined && val !== null) ? val : null;
    },

    // ========== PERIOD NORMALIZATION ==========

    normalizePeriod: function(periodStr) {
        if (!periodStr) return null;
        periodStr = String(periodStr).trim();

        // Already YYYY-MM
        if (/^\d{4}-\d{2}$/.test(periodStr)) return periodStr;

        // YYYY/MM
        if (/^\d{4}\/\d{2}$/.test(periodStr)) return periodStr.replace('/', '-');

        // MM/YYYY
        var match = periodStr.match(/^(\d{2})\/(\d{4})$/);
        if (match) return match[2] + '-' + match[1];

        // MM-YYYY
        match = periodStr.match(/^(\d{2})-(\d{4})$/);
        if (match) return match[2] + '-' + match[1];

        // Month name + year: "June 2023", "Jun 2023", "Jun-2023"
        var months = {
            jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
            apr: '04', april: '04', may: '05', jun: '06', june: '06',
            jul: '07', july: '07', aug: '08', august: '08', sep: '09', september: '09',
            oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12'
        };
        match = periodStr.match(/([a-zA-Z]+)[\s\-]*(\d{4})/);
        if (match) {
            var m = months[match[1].toLowerCase()];
            if (m) return match[2] + '-' + m;
        }

        // Year + month name: "2023 June", "2023-Jun"
        match = periodStr.match(/(\d{4})[\s\-]*([a-zA-Z]+)/);
        if (match) {
            var m2 = months[match[2].toLowerCase()];
            if (m2) return match[1] + '-' + m2;
        }

        return null;
    },

    // ========== MONEY PARSING ==========

    parseMoney: function(val) {
        if (val === null || val === undefined || val === '') return null;
        if (typeof val === 'number') return Math.round(val * 100) / 100;
        var cleaned = String(val).replace(/[R\s,]/g, '');
        var num = parseFloat(cleaned);
        return isNaN(num) ? null : Math.round(num * 100) / 100;
    },

    // ========== DATE NORMALIZATION ==========

    normalizeDate: function(dateStr) {
        if (!dateStr) return null;
        dateStr = String(dateStr).trim();

        // YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

        // DD/MM/YYYY or DD-MM-YYYY
        var match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (match) {
            return match[3] + '-' + String(match[2]).padStart(2, '0') + '-' + String(match[1]).padStart(2, '0');
        }

        // Excel serial number (5 digits)
        if (/^\d{5}$/.test(dateStr)) {
            var serial = parseInt(dateStr);
            var excelDate = new Date((serial - 25569) * 86400 * 1000);
            var y = excelDate.getFullYear();
            var mo = String(excelDate.getMonth() + 1).padStart(2, '0');
            var d = String(excelDate.getDate()).padStart(2, '0');
            return y + '-' + mo + '-' + d;
        }

        return dateStr;
    },

    // ========== SA ID VALIDATION ==========

    validateSAId: function(idNumber) {
        if (!idNumber) return { valid: true, message: '' }; // optional field
        idNumber = String(idNumber).replace(/\s/g, '');
        if (!/^\d{13}$/.test(idNumber)) {
            return { valid: false, message: 'Must be 13 digits' };
        }

        // Luhn algorithm
        var sum = 0;
        for (var i = 0; i < 12; i++) {
            var d = parseInt(idNumber[i]);
            if (i % 2 === 0) {
                sum += d;
            } else {
                d *= 2;
                sum += d > 9 ? d - 9 : d;
            }
        }
        var checkDigit = (10 - (sum % 10)) % 10;
        if (checkDigit !== parseInt(idNumber[12])) {
            return { valid: false, message: 'Invalid ID check digit' };
        }
        return { valid: true, message: '' };
    },

    // ========== ID GENERATION ==========

    generateId: function(prefix) {
        return (prefix || 'id') + '-' + Math.random().toString(36).substr(2, 9);
    },

    // ========== COLUMN MAPPING UI ==========

    renderColumnMappingUI: function(containerId, fileHeaders, fieldAliases, autoMapping, requiredFields) {
        var container = document.getElementById(containerId);
        requiredFields = requiredFields || [];
        var targetFields = Object.keys(fieldAliases);

        var html = '<h4 style="margin-bottom:15px;">Column Mapping</h4>';
        html += '<p style="color:#888; margin-bottom:15px;">Map your file columns to the expected fields. Auto-detected mappings are pre-selected.</p>';
        html += '<div style="display:grid; grid-template-columns:1fr 30px 1fr; gap:10px; align-items:center; max-width:700px;">';

        targetFields.forEach(function(field) {
            var isRequired = requiredFields.indexOf(field) !== -1;
            var label = field.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
            html += '<div style="font-weight:600; color:#555;">' + label;
            if (isRequired) html += ' <span style="color:#dc3545;">*</span>';
            html += '</div>';
            html += '<div style="text-align:center; color:#999;">&#8592;</div>';
            html += '<select id="map_' + field + '" style="padding:8px 12px; border:2px solid #e0e0e0; border-radius:6px; font-size:14px;">';
            html += '<option value="">-- Skip --</option>';
            fileHeaders.forEach(function(h) {
                var selected = (autoMapping[field] === h) ? ' selected' : '';
                html += '<option value="' + h + '"' + selected + '>' + h + '</option>';
            });
            html += '</select>';
        });

        html += '</div>';
        container.innerHTML = html;
    },

    // Read current mapping selections from the UI
    readColumnMapping: function(fieldAliases) {
        var mapping = {};
        Object.keys(fieldAliases).forEach(function(field) {
            var select = document.getElementById('map_' + field);
            if (select && select.value) {
                mapping[field] = select.value;
            }
        });
        return mapping;
    },

    // ========== PREVIEW TABLE ==========

    renderPreviewTable: function(containerId, data, fields, maxRows) {
        maxRows = maxRows || 10;
        var container = document.getElementById(containerId);
        var displayData = data.slice(0, maxRows);

        var html = '<p style="margin-bottom:10px; color:#666;">Showing ' + displayData.length + ' of ' + data.length + ' rows</p>';
        html += '<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:13px;">';
        html += '<thead><tr style="background:linear-gradient(135deg, #667eea, #764ba2); color:white;">';
        fields.forEach(function(f) {
            var label = f.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
            html += '<th style="padding:10px 8px; text-align:left;">' + label + '</th>';
        });
        html += '</tr></thead><tbody>';

        displayData.forEach(function(row, idx) {
            var bg = idx % 2 === 0 ? '#fff' : '#f8f9fa';
            html += '<tr style="background:' + bg + ';">';
            fields.forEach(function(f) {
                var val = row[f] !== undefined && row[f] !== null ? row[f] : '-';
                var style = 'padding:8px; border-bottom:1px solid #eee;';
                if (row._errors && row._errors[f]) {
                    style += ' background:#f8d7da; color:#721c24;';
                }
                html += '<td style="' + style + '">' + val + '</td>';
            });
            html += '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
    },

    // ========== DRAG AND DROP SETUP ==========

    setupDragDrop: function(dropZoneId, fileInputId, onFileCallback) {
        var dropZone = document.getElementById(dropZoneId);
        var fileInput = document.getElementById(fileInputId);

        if (dropZone) {
            dropZone.addEventListener('dragover', function(e) {
                e.preventDefault();
                dropZone.style.borderColor = '#667eea';
                dropZone.style.background = '#f0f4ff';
            });
            dropZone.addEventListener('dragleave', function(e) {
                e.preventDefault();
                dropZone.style.borderColor = '#ccc';
                dropZone.style.background = '';
            });
            dropZone.addEventListener('drop', function(e) {
                e.preventDefault();
                dropZone.style.borderColor = '#ccc';
                dropZone.style.background = '';
                if (e.dataTransfer.files.length > 0) {
                    onFileCallback(e.dataTransfer.files[0]);
                }
            });
        }

        if (fileInput) {
            fileInput.addEventListener('change', function(e) {
                if (e.target.files.length > 0) {
                    onFileCallback(e.target.files[0]);
                }
            });
        }
    },

    // Setup for multiple file drag-drop (PDF uploads)
    setupMultiDragDrop: function(dropZoneId, fileInputId, onFilesCallback) {
        var dropZone = document.getElementById(dropZoneId);
        var fileInput = document.getElementById(fileInputId);

        if (dropZone) {
            dropZone.addEventListener('dragover', function(e) {
                e.preventDefault();
                dropZone.style.borderColor = '#667eea';
                dropZone.style.background = '#f0f4ff';
            });
            dropZone.addEventListener('dragleave', function(e) {
                e.preventDefault();
                dropZone.style.borderColor = '#ccc';
                dropZone.style.background = '';
            });
            dropZone.addEventListener('drop', function(e) {
                e.preventDefault();
                dropZone.style.borderColor = '#ccc';
                dropZone.style.background = '';
                if (e.dataTransfer.files.length > 0) {
                    onFilesCallback(e.dataTransfer.files);
                }
            });
        }

        if (fileInput) {
            fileInput.addEventListener('change', function(e) {
                if (e.target.files.length > 0) {
                    onFilesCallback(e.target.files);
                }
            });
        }
    },

    // ========== FILE PARSING ==========

    parseFile: function(file, callback) {
        var reader = new FileReader();
        reader.onload = function(e) {
            try {
                var data = new Uint8Array(e.target.result);
                var workbook = XLSX.read(data, { type: 'array' });
                var firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                var jsonData = XLSX.utils.sheet_to_json(firstSheet, { raw: true, defval: '' });
                if (jsonData.length === 0) {
                    callback(null, 'File is empty or has no data rows.');
                    return;
                }
                callback(jsonData, null);
            } catch (err) {
                callback(null, 'Failed to parse file: ' + err.message);
            }
        };
        reader.onerror = function() {
            callback(null, 'Failed to read file.');
        };
        reader.readAsArrayBuffer(file);
    },

    // ========== TEMPLATE DOWNLOAD ==========

    downloadCSVTemplate: function(filename, headers, sampleRows) {
        var csv = headers.join(',') + '\n';
        sampleRows.forEach(function(row) {
            csv += row.join(',') + '\n';
        });
        var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    },

    // ========== AUDIT LOGGING ==========

    logAudit: function(companyId, action, description) {
        if (typeof AuditTrail !== 'undefined') {
            AuditTrail.log(companyId, action, 'bulk_import', description);
        }
    },

    // ========== PAYMENT METHOD NORMALIZATION ==========

    normalizePaymentMethod: function(val) {
        if (!val) return 'EFT';
        var v = String(val).trim().toUpperCase();
        if (v === 'EFT' || v === 'ELECTRONIC' || v === 'BANK TRANSFER' || v === 'BANK') return 'EFT';
        if (v === 'CASH') return 'Cash';
        if (v === 'CHEQUE' || v === 'CHECK') return 'Cheque';
        return 'EFT';
    }
};
