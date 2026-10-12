# 11 — Net-to-Gross

> Status: **KONSEP** · Skerm: `net-to-gross.html`

## Doel

Gegee 'n gewenste netto (wat in die bank moet beland) en bekende toelaes/aftrekkings, bereken die basiese salaris wat nodig is — met presies dieselfde reëls as die gewone payroll.

## Reëls

| # | Reël | Status |
|---|---|---|
| NG-01 | Bereken op die backend-enjin (dieselfde tabelle as Execute Payroll), nie in die blaaier nie. | ❌ Gebruik die frontend-enjin met verouderde tabelle [B5] |
| NG-02 | Bekende toelaes word as **herhalende** items behandel (tensy die gebruiker "eenmalig" kies). | ❌ Almal as eenmalig behandel [B12] |
| NG-03 | Resultaat = netto binne R0,01 van die teiken; toon die volle payslip-uiteensetting. | ✅ |
| NG-04 | Opsie om die resultaat direk as die werknemer se nuwe basiese salaris te stoor (met bevestiging). | ❓ |

## ❓ Vrae vir Ruan

1. NG-04: wil jy 'n "pas toe op werknemer"-knoppie?
