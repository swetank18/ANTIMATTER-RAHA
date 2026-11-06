"""Build the hackathon submission PDF from the measured results.

python scripts/make_submission_pdf.py [live_url]
-> RAHA_Submission_Team_Antimatter.pdf

All numbers come from results/summary.json (scripts/run_experiments.mjs) and data/scenarios.json.
"""
import json
import os
import sys
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = sys.argv[1] if len(sys.argv) > 1 else "(add the live URL after deploying, see DEPLOY.md)"
REPO = "https://github.com/swetank18/ANTIMATTER-RAHA"
D = json.load(open(os.path.join(ROOT, "data/scenarios.json"), encoding="utf-8"))
R = json.load(open(os.path.join(ROOT, "results/summary.json"), encoding="utf-8"))
SC = {s["id"]: s for s in D["scenarios"]}

NAVY, INK, DIM, ACC, WARM, OK, BAD = (colors.HexColor(x) for x in ("#0b1430", "#1b2433", "#5b6478", "#2f5bd3", "#e8892b", "#14804a", "#c0392b"))
ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=17, textColor=NAVY, spaceBefore=6, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, textColor=ACC, spaceBefore=10, spaceAfter=5)
B = ParagraphStyle("B", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.6, leading=13.4, textColor=INK, spaceAfter=5)
SM = ParagraphStyle("SM", parent=B, fontSize=8.2, leading=11, textColor=DIM)
CELL = ParagraphStyle("CELL", parent=B, fontSize=8.2, leading=10.4, spaceAfter=0)
CELLB = ParagraphStyle("CELLB", parent=CELL, fontName="Helvetica-Bold")
BUL = ParagraphStyle("BUL", parent=B, leftIndent=12, bulletIndent=2, spaceAfter=2)


def P(t, st=B):
    return Paragraph(t, st)


def bullets(items):
    return [Paragraph(x, BUL, bulletText="•") for x in items]


def table(rows, widths, head=True, zebra=True, align_right_from=1):
    data = [[c if not isinstance(c, str) else Paragraph(c, CELLB if (head and i == 0) else CELL) for c in r] for i, r in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if head else 0)
    style = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#c9d1e4")),
             ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if head:
        style += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e7ecf8"))]
    if zebra:
        for i in range(1 if head else 0, len(rows)):
            if i % 2 == 0:
                style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#f6f8fc")))
    t.setStyle(TableStyle(style))
    return t


def f(x, d=0):
    if x is None:
        return "–"
    return f"{x:,.{d}f}"


def ci(m, k, d=0):
    v = m.get(k)
    if not v:
        return "–"
    return f"{f(v[0], d)} <font color='#5b6478' size='7'>[{f(v[1], d)}–{f(v[2], d)}]</font>"


def on_page(c, doc):
    w, h = A4
    c.saveState()
    c.setFillColor(NAVY); c.rect(0, h - 14 * mm, w, 14 * mm, stroke=0, fill=1)
    c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 10.5); c.drawString(15 * mm, h - 9 * mm, "RAHA · Stranded Network Recovery")
    c.setFont("Helvetica", 8.5); c.drawRightString(w - 15 * mm, h - 9 * mm, "Team Antimatter · SRMIST Chennai · PS2 The Stranded Network")
    c.setFillColor(DIM); c.setFont("Helvetica", 7.8)
    c.drawString(15 * mm, 9 * mm, f"Results generated {R['stamp']['date'][:10]} · {R['stamp']['seeds']} seeds per policy · engine src/sim/engine.js")
    c.drawRightString(w - 15 * mm, 9 * mm, f"Page {doc.page}")
    c.restoreState()


def cover(c, doc):
    w, h = A4
    c.saveState()
    c.setFillColor(NAVY); c.rect(0, 0, w, h, stroke=0, fill=1)
    c.setFillColor(colors.HexColor("#1d2a55")); c.circle(w * 0.78, h * 0.72, 120, stroke=0, fill=1)
    c.setFillColor(colors.HexColor("#3b2a3f")); c.wedge(w * 0.78 - 120, h * 0.72 - 200, w * 0.78 + 120, h * 0.72 + 40, 245, 50, stroke=0, fill=1)
    c.setFillColor(WARM); c.setFont("Helvetica-Bold", 10); c.drawString(22 * mm, h - 40 * mm, "CODENEX · THE OTHER SIDE: HACK THE CONSTRAINT 2026 · TRAVEL & MOBILITY")
    c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 64); c.drawString(22 * mm, h - 80 * mm, "RAHA")
    c.setFont("Helvetica", 17); c.drawString(22 * mm, h - 93 * mm, "Fair, capacity-exact, offline-first recovery")
    c.drawString(22 * mm, h - 102 * mm, "for stranded transit networks")
    c.setFillColor(colors.HexColor("#b9c6ea")); c.setFont("Helvetica", 11)
    c.drawString(22 * mm, h - 116 * mm, "Problem Statement 2: The Stranded Network")
    c.drawString(22 * mm, h - 123 * mm, "Surprise constraints: (1) no internet or third-party APIs, (3) API response structure changes")
    y = h - 160 * mm
    c.setFillColor(WARM); c.setFont("Helvetica-Bold", 11); c.drawString(22 * mm, y, "TEAM ANTIMATTER")
    c.setFillColor(colors.white); c.setFont("Helvetica", 11.5)
    for i, line in enumerate(["Utkarsh Sharma  ·  Team Leader, simulation and research (RAHA simulator)", "Swetank Kumar  ·  Team member (backend and rider app)", "Devansh Pathak  ·  Team member (backend and rider app)"]):
        c.drawString(22 * mm, y - (8 + i * 7) * mm, line)
    c.setFillColor(colors.HexColor("#b9c6ea")); c.setFont("Helvetica", 10.5)
    c.drawString(22 * mm, y - 36 * mm, "SRM Institute of Science and Technology (SRMIST), Kattankulathur, Chennai")
    c.drawString(22 * mm, y - 43 * mm, "Venue: SRMIST Chennai (TP2 712)  ·  Platform: Manch  ·  Internship partner: SpazorLabs")
    c.setFont("Helvetica", 9.5); c.setFillColor(colors.HexColor("#8f9cc4"))
    c.drawString(22 * mm, 30 * mm, f"Live simulation: {LIVE}")
    c.drawString(22 * mm, 24 * mm, f"Code: {REPO}")
    c.drawString(22 * mm, 18 * mm, f"Submitted {date.today().isoformat()}  ·  every number in this document is reproducible: node scripts/run_experiments.mjs 200")
    c.restoreState()


story = [PageBreak()]
S = R["scenarios"]

# 1 -------------------------------------------------------------- summary
story += [P("1. Summary", H1)]
tam = S["tambaram"]["main"]
story += [P("When a rail line fails, thousands of riders are stranded at once. Everyone opens a cab app and the fare surges. Forty people going the same way book forty cabs. Replacement buses arrive late and in the wrong places, and the crowd crushes at the doors. <b>RAHA</b> turns that free-for-all into a coordinated recovery:")]
story += bullets([
    "bridging buses whose passes match seats exactly",
    "the most vulnerable and urgent riders served first, with a written explanation for every decision",
    "<b>Koottu</b> shared cabs in trusted circles, so sharing costs less than riding alone even at surge",
    "a geofence that brings in two-wheeler partners and essentials drops",
])
story += [P("It keeps working with the internet cut (Constraint 1) and when a data feed changes shape (Constraint 3).")]
story += [P("We built a simulator that replays <b>five real disruptions</b> (Chennai, New Delhi, Mumbai, Singapore and Madrid) on islands made from real OpenStreetMap data. It measures RAHA against four honest alternatives over 200 seeded runs each.")]
story += [P(f"<b>Headline (Chennai, Tambaram station, 28 Feb 2026, 200 runs):</b> the worst-off rider waited {f(tam['FREE_FOR_ALL']['worstWait'][0])} min under free-for-all, {f(tam['FCFS']['worstWait'][0])} min under a first-come-first-served app and <b>{f(tam['RAHA']['worstWait'][0])} min under RAHA</b>. Failed boarding attempts at bus doors fell from {f(tam['FREE_FOR_ALL']['turnedAway'][0])} to <b>{f(tam['RAHA']['turnedAway'][0])}</b>. Deadlines met rose from {f(tam['FREE_FOR_ALL']['deadlinesMet'][0] * 100)}% to <b>{f(tam['RAHA']['deadlinesMet'][0] * 100)}%</b>. Koottu carried <b>{f(tam['RAHA']['ridersPerCab'][0], 2)} riders per cab</b> at {f(tam['RAHA']['cabFarePerRider'][0])} rupees each versus {f(tam['RAHA']['cabSoloPerRider'][0])} alone, and nobody paid more than their solo fare.")]

# 2 -------------------------------------------------------------- problem
story += [P("2. The original problem (PS2: The Stranded Network)", H1)]
story += [P("Transit disruptions strand large crowds in minutes, while recovery capacity (buses, cabs, information) arrives in hours and is allocated by whoever pushes, pays or taps fastest. We studied five recent, documented incidents:")]
rows = [["Incident (local date)", "What happened (sourced)", "Why it happened"]]
cause = {"tambaram": "Footfall about 1.5 lakh a day with lagging infrastructure; services already cut from 204 to 164; few agencies keep bus-bridging reserves (Pender et al., 2013).",
         "ndls": "Tickets not linked to seats; similar train names caused confusion; a single staircase between platforms (Fruin's FIST model: Force, Information, Space, Time).",
         "kurla": "Drains handle about 25 mm/h at low tide; only 3 of 45 outfalls have floodgates; footbridges too narrow (Elphinstone 2017: 2.4 m, 23 dead).",
         "jurong": "Axle-box failure after an overhaul interval was extended without assessment; bridging point an 8-minute walk away; riders confused between bus services.",
         "atocha": "Grid voltage-control failure (ENTSO-E); every cloud-dependent app and payment system stopped together; mobile networks degraded."}
for s in D["scenarios"]:
    rows.append([f"<b>{s['title']}</b><br/>{s['station']}<br/>{s['date']}", s["headline"], cause[s["id"]]])
story += [table(rows, [34 * mm, 72 * mm, 74 * mm])]

# 3 -------------------------------------------------------------- solution
story += [P("3. Our solution: RAHA", H1)]
story += bullets([
    "<b>Bridging with capacity-exact passes.</b> Riders are grouped by real destination corridor. Buses go where the most urgent riders wait, and accessible buses go where wheelchair users wait. A pass exists only if a seat exists. Pass holders are released from a holding area in waves at no more than 1 person per square metre (Fruin level D).",
    "<b>Fair, explainable priority.</b> Score = 35·V (vulnerability) + 30·D (deadline urgency) + 25·W (wait, which never decreases) − 10·C (detour). Willingness to pay is never an input. A refused rider receives a refusal proof: score, cutoff and rank, sealed with a SHA-256 record hash.",
    "<b>Koottu shared cabs.</b> Surge is charged per car, not per person, so sharing at the 2× legal cap costs less than riding alone at the normal fare. Groups form inside trusted circles (the Zimride model that became Lyft). The cheapest of the group's phone quotes books the cab. The split uses the Shapley value (airport game), and the rule that nobody pays more than their solo fare is enforced directly in code. Fares are checked against the 2× cap of the Motor Vehicle Aggregator Guidelines 2025.",
    "<b>Geofence, two-wheelers and essentials.</b> Riders, cabs and delivery partners inside the geofence are alerted. Bike-taxi or delivery partners take urgent solo riders where state law allows (Karnataka banned bike taxis in 2025). Riders waiting more than 45 minutes are flagged for water and food drops.",
])

# 4 -------------------------------------------------------------- constraints
story += [P("4. The surprise constraints and how we adapted", H1)]
c1, c3 = D["constraints"]
for c in (c1, c3):
    story += [KeepTogether([P(f"{c['id'].title()}: {c['title']}", H2), P(f"<i>Card:</i> {c['card']}", SM), P("<b>How RAHA adapts (product)</b>")] + bullets(c["product"]) + [P("<b>How the simulator implements and proves it</b>")] + bullets(c["sim"]))]

# 5 -------------------------------------------------------------- method
story += [P("5. How we tested: the RAHA simulator", H1)]
story += bullets([
    "<b>Real geography and timelines.</b> OpenStreetMap geometry for each hub (buildings, roads, rail, platforms, footbridges, bus stops). Destination stations at their real coordinates and distances. Timetables from the Indian Railways and Chennai MTC GTFS feeds. Incident timelines from cited reports. Demographics from Census 2011.",
    "<b>Data tiers.</b> Every input is T1 (observed), T2 (derived by formula), T3 (research constant) or T4 (assumption). T4 values are stated and stress-tested. Individual riders are sampled from real counts and distributions, because no per-person data exists.",
    "<b>One deterministic engine.</b> A discrete-event simulation (src/sim/engine.js) drives both the 3D replay and the statistics. Paired comparisons use the same riders and fleet per seed.",
    "<b>Five policies.</b> Free-for-all (status quo), digital first-come-first-served, market pricing (highest bidder), pure throughput (ignores need), and RAHA.",
    "<b>Checks.</b> A physical sanity bound (clearance ≥ (waves − 1) × shortest round trip); sensitivity runs with door-crush delay at 0, demand ×0.5 and ×2, and fleet ×0.5; a Constraint 1 phone-reach sweep; and six Constraint 3 mutation classes.",
])

# 6 -------------------------------------------------------------- results
story += [PageBreak(), P("6. Results of testing (mean over 200 seeds, 95% bootstrap interval)", H1)]
pols = ["FREE_FOR_ALL", "FCFS", "SURGE", "UTILITARIAN", "RAHA"]
lab = {"FREE_FOR_ALL": "Free-for-all", "FCFS": "FCFS app", "SURGE": "Market", "UTILITARIAN": "Throughput", "RAHA": "<b>RAHA</b>"}
for sid in ["tambaram", "ndls", "kurla", "jurong", "atocha"]:
    if sid not in S:
        continue
    m = S[sid]["main"]
    rows = [["Metric"] + [lab[p] for p in pols]]
    spec = [("worstWait", "Worst-off wait (min)", 0), ("meanWait", "Mean wait (min)", 1), ("wheelchairP95", "Wheelchair p95 wait (min)", 0), ("deadlinesMet", "Deadlines met (share)", 2), ("turnedAway", "Turned away at doors", 0), ("peakDoorDensity", "Peak door density (p/m²)", 2), ("unserved", "Unserved at horizon", 0)]
    if m["RAHA"].get("ridersPerCab") and m["RAHA"]["ridersPerCab"][0] > 0:
        spec += [("ridersPerCab", "Riders per cab", 2), ("cabFarePerRider", f"Cab fare per rider ({SC[sid]['currency']})", 0 if SC[sid]['currency'] == 'Rs' else 2)]
    for k, name, d in spec:
        if all(not m[p].get(k) for p in pols):
            continue
        rows.append([name] + [ci(m[p], k, d) for p in pols])
    story += [KeepTogether([P(f"{SC[sid]['title']} ({SC[sid]['station']}) · {SC[sid]['date']} · N = {f(S[sid]['N'])} riders · sanity bound {f(S[sid]['sanityBoundMin'])} min", H2), table(rows, [42 * mm] + [27.6 * mm] * 5)])]

# C1 / C3 tables
if S.get("atocha", {}).get("c1"):
    c1r = S["atocha"]["c1"]
    rows = [["Phone reach after the cut", "Free-for-all", "FCFS app (cloud)", "RAHA (cloud)", "RAHA (edge node)"]]
    for rk, row in c1r.items():
        rows.append([rk.replace("reach_", "") + (" (no cut)" if rk == "reach_1" else "")] + [f"{f(row[k]['worstWait'][0])} min · {f(row[k]['turnedAway'][0])} turned away" for k in ["FREE_FOR_ALL", "FCFS_app", "RAHA_cloud", "RAHA_local"]])
    story += [KeepTogether([P("Constraint 1 test: internet cut at 12:33 in the Madrid blackout, worst-off wait · turned away", H2), table(rows, [36 * mm, 36 * mm, 36 * mm, 36 * mm, 36 * mm]), P("A coordinator that lives in the cloud collapses into free-for-all the moment the internet goes. RAHA's local-first edge node keeps every guarantee at every level of phone reach.", SM)])]
if S.get("jurong", {}).get("c3"):
    c3r = S["jurong"]["c3"]
    rows = [["Feed mutation (from 10:30)", "Naive parser: empty buses · turned away · worst wait", "RAHA adapter: empty buses · turned away · worst wait"]]
    for cls, x in c3r.items():
        rows.append([cls, f"{f(x['naive']['emptyDepartures'][0])} · {f(x['naive']['turnedAway'][0])} · {f(x['naive']['worstWait'][0])} min", f"{f(x['adapter']['emptyDepartures'][0])} · {f(x['adapter']['turnedAway'][0])} · {f(x['adapter']['worstWait'][0])} min"])
    story += [KeepTogether([P("Constraint 3 test: provider feed changes shape mid-incident (Singapore line closure)", H2), table(rows, [40 * mm, 70 * mm, 70 * mm]), P("Rename, nest, retype, optional, garbage and semantic drift: the naive parser reads NaN, throws, or trusts a field whose meaning changed, so buses leave empty or are overbooked. RAHA's adapter (aliases, coercion, invariants, last-known-good values and a local registry) keeps every seat count correct.", SM)])]
sens = S["tambaram"]["sensitivity"]
rows = [["Stress test (Chennai)", "Free-for-all worst wait", "FCFS worst wait", "RAHA worst wait", "RAHA turned away"]]
for k, name in [("doorCrush0", "No door-crush delay for free-for-all"), ("demandHalf", "Demand ×0.5"), ("demandDouble", "Demand ×2"), ("fleetHalf", "Fleet ×0.5")]:
    v = sens[k]
    rows.append([name, f(v["FREE_FOR_ALL"]["worstWait"][0]), f(v["FCFS"]["worstWait"][0]), f(v["RAHA"]["worstWait"][0]), f(v["RAHA"]["turnedAway"][0])])
story += [KeepTogether([P("Sensitivity: do the conclusions survive?", H2), table(rows, [60 * mm, 30 * mm, 30 * mm, 30 * mm, 30 * mm])])]
story += [P("<b>Live judge check.</b> Pressing J in the simulator re-runs both constraint tests in the judge's own browser:", B)]
story += bullets([
    "blocks a real call to example.com",
    "reports the offline cache status",
    "runs all six API mutations against the actual parser code",
    "simulates the internet cut",
    "proves determinism (same seed, same SHA-256)",
])

# 7 -------------------------------------------------------------- business
Bz = D["business"]
story += [P("7. Viability and business model", H1), P(Bz["thesis"])]
rows = [["Who pays", "Model", "Why"]] + [[x["who"], x["model"], x["why"]] for x in Bz["streams"]]
story += [table(rows, [42 * mm, 38 * mm, 100 * mm])]
story += [P("<b>Go to market.</b> " + Bz["gtm"]), P("<b>Evidence the market pays.</b> " + " ".join(p["x"] for p in Bz["proof"])), P("<b>Risks.</b> " + Bz["risks"], SM)]

# 8 -------------------------------------------------------------- limits
story += [P("8. Honest limits", H1)]
story += bullets([
    "RAHA cannot switch surge pricing off. It makes surge hurt less.",
    "Rider populations are synthetic, drawn from real counts and distributions. Assumptions are labelled T4 and stress-tested.",
    "The 2× surge cap is a central guideline. No Tamil Nadu notification adopting it was found, so without a verified base fare the check says \"cannot check\".",
    "Grouping is a heuristic, not an optimum. Two-wheeler rides and multi-stop pooling depend on state permits.",
    "Station footfall, fleet and fare figures that were not published are explicit assumptions; each one is listed in the simulator's Data tab.",
])

# 9 -------------------------------------------------------------- references
story += [P("9. Key sources", H1)]
keys = ["dtnext_tam", "dtnext_egmore", "dtnext_footfall", "ndls_scroll", "ndls_week", "ndls_inquiry", "ndls_holding", "mum_suspend", "mum_drains", "elph_fob", "sg_mot", "sg_ltg", "sg_fine", "es_entsoe", "es_cause", "es_riskline", "es_net", "pender", "jin2016", "fruin", "fruin_los", "helbing2012", "localfirst", "fowler", "espinha", "mta", "surge_cap", "zimride", "pnas2014", "shapley_rs", "airport_game", "bertsimas", "via_ipo", "ir_76", "ir_amenities", "osm"]
for k in keys:
    s = D["sources"].get(k)
    if s:
        story.append(P(f"<b>{s['o']}</b> ({s['d']}). {s['t']}. <font color='#2f5bd3'>{s['u']}</font>", SM))
story += [Spacer(1, 6), P("Map data © OpenStreetMap contributors (ODbL). Natural Earth (public domain). three.js (MIT).", SM)]

out = os.path.join(ROOT, "RAHA_Submission_Team_Antimatter.pdf")
doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=20 * mm, bottomMargin=16 * mm,
                        title="RAHA: Team Antimatter submission", author="Team Antimatter (Utkarsh Sharma, Swetank Kumar, Devansh Pathak), SRMIST Chennai", subject="PS2 The Stranded Network")
doc.build(story, onFirstPage=cover, onLaterPages=on_page)
print("wrote", out)
