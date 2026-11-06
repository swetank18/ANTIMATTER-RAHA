"""Render PITCH.md (explanation + pitch guide) as a clean PDF.

python scripts/make_pitch_pdf.py  ->  RAHA_Pitch_and_Explanation_Team_Antimatter.pdf
Handles the Markdown used in PITCH.md: headings, paragraphs, bullets, numbered lists, tables, quotes, bold, code.
"""
import os
import re
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE = sys.argv[1] if len(sys.argv) > 1 else "(add the live URL after deploying)"
NAVY, INK, DIM, ACC, WARM = (colors.HexColor(x) for x in ("#0b1430", "#1b2433", "#5b6478", "#2f5bd3", "#e8892b"))
ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=20, textColor=NAVY, spaceAfter=6)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=13.5, textColor=ACC, spaceBefore=10, spaceAfter=5)
B = ParagraphStyle("B", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.8, leading=13.6, textColor=INK, spaceAfter=5)
Q = ParagraphStyle("Q", parent=B, leftIndent=10, borderPadding=6, backColor=colors.HexColor("#eef2fb"), textColor=NAVY, spaceBefore=4, spaceAfter=8)
BUL = ParagraphStyle("BUL", parent=B, leftIndent=12, bulletIndent=2, spaceAfter=2)
BUL2 = ParagraphStyle("BUL2", parent=BUL, leftIndent=24, bulletIndent=14)
CELL = ParagraphStyle("CELL", parent=B, fontSize=8.4, leading=10.8, spaceAfter=0)
CELLB = ParagraphStyle("CELLB", parent=CELL, fontName="Helvetica-Bold")
SUB = ParagraphStyle("SUB", parent=B, textColor=DIM, fontSize=10)


def inline(t):
    t = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<i>\1</i>", t)
    t = re.sub(r"`([^`]+)`", r"<font face='Courier'>\1</font>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", t)
    return t


def page(c, doc):
    w, h = A4
    c.saveState()
    c.setFillColor(NAVY); c.rect(0, h - 13 * mm, w, 13 * mm, stroke=0, fill=1)
    c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 10); c.drawString(15 * mm, h - 8.5 * mm, "RAHA · Pitch and explanation")
    c.setFont("Helvetica", 8.5); c.drawRightString(w - 15 * mm, h - 8.5 * mm, "Team Antimatter · Utkarsh Sharma · Swetank Kumar · Devansh Pathak · SRMIST Chennai")
    c.setFillColor(DIM); c.setFont("Helvetica", 7.8); c.drawString(15 * mm, 9 * mm, f"Live simulation: {LIVE}"); c.drawRightString(w - 15 * mm, 9 * mm, f"Page {doc.page}")
    c.restoreState()


lines = open(os.path.join(ROOT, "PITCH.md"), encoding="utf-8").read().splitlines()
story, i, n = [], 0, len(lines)
while i < n:
    L = lines[i].rstrip()
    if not L.strip() or L.strip() == "---":
        i += 1; continue
    if L.startswith("# "):
        story += [Paragraph(inline(L[2:]), H1)]; i += 1; continue
    if L.startswith("## "):
        story += [Paragraph(inline(L[3:]), H2)]; i += 1; continue
    if L.startswith("|"):
        rows = []
        while i < n and lines[i].startswith("|"):
            cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
            if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                rows.append(cells)
            i += 1
        cols = max(len(r) for r in rows)
        widths = {2: [45 * mm, 135 * mm], 3: [38 * mm, 66 * mm, 76 * mm], 4: [30 * mm, 46 * mm, 52 * mm, 52 * mm]}.get(cols, [180 * mm / cols] * cols)
        data = [[Paragraph(inline(c), CELLB if r == 0 else CELL) for c in row + [""] * (cols - len(row))] for r, row in enumerate(rows)]
        t = Table(data, colWidths=widths, repeatRows=1)
        st = [("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#c9d1e4")), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e7ecf8")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
              ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
        for r in range(2, len(rows), 2):
            st.append(("BACKGROUND", (0, r), (-1, r), colors.HexColor("#f6f8fc")))
        t.setStyle(TableStyle(st)); story += [t, Spacer(1, 6)]; continue
    if L.startswith(">"):
        buf = []
        while i < n and lines[i].startswith(">"):
            s = lines[i][1:].strip()
            buf.append(("• " + s[2:]) if s.startswith("- ") else s)
            i += 1
        story += [Paragraph("<br/>".join(inline(x) for x in buf if x), Q)]; continue
    m = re.match(r"^(\s*)(?:[-*]|(\d+)\.)\s+(.*)$", L)
    if m:
        indent, num, txt = m.group(1), m.group(2), m.group(3)
        style = BUL2 if len(indent) >= 2 else BUL
        story += [Paragraph(inline(txt), style, bulletText=(f"{num}." if num else "•"))]; i += 1; continue
    if L.startswith("```"):
        i += 1
        while i < n and not lines[i].startswith("```"):
            story += [Paragraph(f"<font face='Courier'>{inline(lines[i])}</font>", B)]; i += 1
        i += 1; continue
    buf = [L.strip()]
    i += 1
    while i < n and lines[i].strip() and not re.match(r"^(#|\||>|\s*[-*]\s|\s*\d+\.\s|```)", lines[i]):
        buf.append(lines[i].strip()); i += 1
    story += [Paragraph(inline(" ".join(buf)), B)]

story.insert(1, Paragraph(f"Team Antimatter · SRM Institute of Science and Technology (SRMIST), Chennai · Live simulation: {LIVE}", SUB))
out = os.path.join(ROOT, "RAHA_Pitch_and_Explanation_Team_Antimatter.pdf")
SimpleDocTemplate(out, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=19 * mm, bottomMargin=15 * mm,
                  title="RAHA: pitch and explanation", author="Team Antimatter, SRMIST Chennai").build(story, onFirstPage=page, onLaterPages=page)
print("wrote", out)
