# 11 — Net-to-Gross

> Status: **KONSEP** · Skerm: `net-to-gross.html`

## Doel

Gegee 'n gewenste netto (wat in die bank moet beland) en bekende toelaes/aftrekkings, bereken die basiese salaris wat nodig is — met presies dieselfde reëls as die gewone payroll.

## Reëls

| # | Reël | Status |
|---|---|---|
| NG-01 | Bereken op die backend-enjin (dieselfde tabelle as Execute Payroll), nie in die blaaier nie. | ✅ Fase 9: `POST /api/payroll/calculate/net-to-gross`, die periode se eie tabelle [B5] |
| NG-02 | Bekende toelaes word as **herhalende** items behandel (tensy die gebruiker "eenmalig" kies). | ✅ Fase 9: "Monthly" by verstek aangemerk; ontmerk = eenmalig [B12 reg] |
| NG-03 | Resultaat = netto binne R0,01 van die teiken; toon die volle payslip-uiteensetting. | ✅ |
| NG-04 | Opsie om die resultaat direk as die werknemer se nuwe basiese salaris te stoor (met bevestiging). | ❓ |

## ❓ Vrae vir Ruan

1. NG-04: wil jy 'n "pas toe op werknemer"-knoppie?
