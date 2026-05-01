const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  ImageRun,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  WidthType,
  ShadingType,
  VerticalAlign,
  PageBreak,
  LevelFormat,
  PageNumber,
  Header,
  Footer,
  TabStopType,
  TabStopPosition,
} = require("docx");
const fs = require("fs");
const path = require("path");

const img1 = fs.readFileSync("/home/claude/img/flowchart1.png");
const img2 = fs.readFileSync("/home/claude/img/flowchart2.png");

const BLUE = "1F3C6E";
const LBLUE = "D6E8F5";
const GRAY = "F2F4F6";
const WHITE = "FFFFFF";
const BLACK = "1A1A2E";

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = {
  top: noBorder,
  bottom: noBorder,
  left: noBorder,
  right: noBorder,
};

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 120 },
    children: [
      new TextRun({ text, font: "Arial", size: 28, bold: true, color: BLUE }),
    ],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 80 },
    children: [
      new TextRun({
        text,
        font: "Arial",
        size: 24,
        bold: true,
        color: "2C5F8A",
      }),
    ],
  });
}

function para(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { before: 80, after: 80, line: 340 },
    children: [
      new TextRun({ text, font: "Arial", size: 22, color: BLACK, ...opts }),
    ],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, font: "Arial", size: 22, color: BLACK })],
  });
}

function numbered(text) {
  return new Paragraph({
    numbering: { reference: "numbers", level: 0 },
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, font: "Arial", size: 22, color: BLACK })],
  });
}

function spacer(before = 120) {
  return new Paragraph({
    spacing: { before, after: 0 },
    children: [new TextRun("")],
  });
}

function sectionBox(title) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders,
            width: { size: 9360, type: WidthType.DXA },
            shading: { fill: BLUE, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 200, right: 200 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: title,
                    font: "Arial",
                    size: 26,
                    bold: true,
                    color: WHITE,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function infoTable(rows) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [2800, 6560],
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              borders,
              width: { size: 2800, type: WidthType.DXA },
              shading: { fill: LBLUE, type: ShadingType.CLEAR },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: label,
                      font: "Arial",
                      size: 22,
                      bold: true,
                      color: BLUE,
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              borders,
              width: { size: 6560, type: WidthType.DXA },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: value,
                      font: "Arial",
                      size: 22,
                      color: BLACK,
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

function complexityTable() {
  const hdr = ["Algorithm", "Time Complexity", "Space", "Optimal?", "Use When"];
  const rows_data = [
    ["Brute Force", "O(n!)", "O(n)", "Yes", "n ≤ 8"],
    ["Held-Karp DP", "O(n² · 2ⁿ)", "O(n · 2ⁿ)", "Yes", "n ≤ 15"],
    ["Nearest Neighbor", "O(n²)", "O(n)", "No (~25% suboptimal)", "Any n"],
    [
      "2-opt Local Search",
      "O(n² · k)",
      "O(n)",
      "No (local optimum)",
      "Post-heuristic",
    ],
  ];
  const rowColors = [GRAY, "D5F5E3", "FAE5D3", "EAD5F5"];
  const colW = [2100, 1800, 1400, 1800, 2260];

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: colW,
    rows: [
      new TableRow({
        tableHeader: true,
        children: hdr.map(
          (h, i) =>
            new TableCell({
              borders,
              width: { size: colW[i], type: WidthType.DXA },
              shading: { fill: BLUE, type: ShadingType.CLEAR },
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: h,
                      font: "Arial",
                      size: 20,
                      bold: true,
                      color: WHITE,
                    }),
                  ],
                }),
              ],
            }),
        ),
      }),
      ...rows_data.map(
        (row, i) =>
          new TableRow({
            children: row.map(
              (cell, j) =>
                new TableCell({
                  borders,
                  width: { size: colW[j], type: WidthType.DXA },
                  shading: {
                    fill: j === 0 ? rowColors[i] : WHITE,
                    type: ShadingType.CLEAR,
                  },
                  margins: { top: 60, bottom: 60, left: 100, right: 100 },
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new TextRun({
                          text: cell,
                          font: "Arial",
                          size: 19,
                          color: BLACK,
                          bold: j === 0,
                        }),
                      ],
                    }),
                  ],
                }),
            ),
          }),
      ),
    ],
  });
}

function imageBlock(imgBuffer, w, h, caption) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 80 },
      children: [
        new ImageRun({
          data: imgBuffer,
          transformation: { width: w, height: h },
          type: "png",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 160 },
      children: [
        new TextRun({
          text: caption,
          font: "Arial",
          size: 19,
          italics: true,
          color: "666666",
        }),
      ],
    }),
  ];
}

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "\u2022",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
      {
        reference: "numbers",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
    ],
  },
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: BLUE },
        paragraph: { spacing: { before: 360, after: 120 }, outlineLevel: 0 },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: "2C5F8A" },
        paragraph: { spacing: { before: 240, after: 80 }, outlineLevel: 1 },
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              border: {
                bottom: {
                  style: BorderStyle.SINGLE,
                  size: 4,
                  color: BLUE,
                  space: 6,
                },
              },
              children: [
                new TextRun({
                  text: "Project Synopsis  |  Design & Analysis of Algorithms",
                  font: "Arial",
                  size: 18,
                  color: "888888",
                }),
                new TextRun({
                  text: "  |  2nd Year B.Tech CSE",
                  font: "Arial",
                  size: 18,
                  color: "AAAAAA",
                }),
              ],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              border: {
                top: {
                  style: BorderStyle.SINGLE,
                  size: 4,
                  color: BLUE,
                  space: 6,
                },
              },
              tabStops: [
                { type: TabStopType.RIGHT, position: TabStopPosition.MAX },
              ],
              children: [
                new TextRun({
                  text: "Delivery Route Optimizer using TSP Algorithms",
                  font: "Arial",
                  size: 18,
                  color: "888888",
                }),
                new TextRun({
                  text: "\tPage ",
                  font: "Arial",
                  size: 18,
                  color: "888888",
                }),
                new TextRun({
                  children: [PageNumber.CURRENT],
                  font: "Arial",
                  size: 18,
                  color: "888888",
                }),
              ],
            }),
          ],
        }),
      },
      children: [
        // ─── COVER ───
        spacer(400),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: "PROJECT SYNOPSIS",
              font: "Arial",
              size: 48,
              bold: true,
              color: BLUE,
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 160, after: 80 },
          children: [
            new TextRun({
              text: "Design and Analysis of Algorithms",
              font: "Arial",
              size: 28,
              color: "555555",
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 20, after: 320 },
          children: [
            new TextRun({
              text: "B.Tech Computer Science Engineering  |  2nd Year",
              font: "Arial",
              size: 22,
              color: "888888",
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 40 },
          children: [
            new TextRun({
              text: "Delivery Route Optimizer",
              font: "Arial",
              size: 40,
              bold: true,
              color: BLACK,
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 400 },
          children: [
            new TextRun({
              text: "Using TSP Approximation Algorithms",
              font: "Arial",
              size: 30,
              color: "2C5F8A",
            }),
          ],
        }),
        infoTable([
          ["Subject", "Design and Analysis of Algorithms (DAA)"],
          ["Year / Semester", "2nd Year — Semester III / IV"],
          ["Submitted By", "[ Student Name(s) ]"],
          ["Roll Number(s)", "[ Roll No. ]"],
          ["Institution", "[ College / University Name ]"],
          ["Guide / Faculty", "[ Faculty Name, Designation ]"],
          ["Academic Year", "2025 – 2026"],
        ]),
        spacer(200),
        new Paragraph({ children: [new PageBreak()] }),

        // ─── 1. TITLE ───
        sectionBox("1. Title"),
        spacer(120),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 100, after: 80 },
          children: [
            new TextRun({
              text: "Delivery Route Optimizer Using TSP Approximation Algorithms",
              font: "Arial",
              size: 32,
              bold: true,
              color: BLUE,
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 200 },
          children: [
            new TextRun({
              text: "A Comparative Study of Exact, Heuristic, and Local Search Approaches to the Travelling Salesman Problem",
              font: "Arial",
              size: 22,
              italics: true,
              color: "555555",
            }),
          ],
        }),

        // ─── 2. ABSTRACT ───
        spacer(160),
        sectionBox("2. Abstract"),
        spacer(120),
        para(
          "The Travelling Salesman Problem (TSP) is one of the most extensively studied combinatorial optimization problems in computer science. It asks: given a set of cities and the distances between them, what is the shortest possible route that visits every city exactly once and returns to the starting point? Despite its simple formulation, TSP is NP-Hard, meaning no known polynomial-time algorithm can solve all instances optimally.",
        ),
        spacer(60),
        para(
          "This project implements and compares three algorithmic strategies of increasing sophistication to tackle the TSP: (i) the Held-Karp Dynamic Programming algorithm, which yields an exact optimal solution in O(n² · 2ⁿ) time for small inputs; (ii) the Nearest Neighbor Greedy Heuristic, which provides a fast but approximate solution in O(n²) time; and (iii) the 2-opt Local Search algorithm, which iteratively improves the heuristic solution by eliminating route crossings.",
        ),
        spacer(60),
        para(
          "The project includes a visual, interactive interface where users can place delivery points on a map or grid, run each algorithm, and observe the optimized route being drawn in real time. A comparison panel displays each algorithm's route length, execution time, and percentage deviation from the optimal solution. This provides a compelling demonstration of the fundamental algorithmic trade-off between solution quality and computational feasibility — a core concept in the study of algorithm design and analysis.",
        ),

        // ─── 3. PROBLEM STATEMENT ───
        spacer(200),
        sectionBox("3. Problem Statement"),
        spacer(120),
        para(
          "Last-mile delivery is one of the most expensive and operationally complex challenges faced by logistics companies such as Amazon, Swiggy, Zomato, and urban courier services. A delivery agent must visit n customer locations and return to the depot, while minimizing total distance traveled — a direct instance of the Travelling Salesman Problem.",
        ),
        spacer(60),
        para("Formally, the problem is defined as follows:"),
        spacer(40),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 80, after: 80, line: 320 },
          indent: { left: 720 },
          children: [
            new TextRun({
              text: "Given:  ",
              font: "Arial",
              size: 22,
              bold: true,
              color: BLUE,
            }),
            new TextRun({
              text: "A complete weighted graph G = (V, E) where V = {v₁, v₂, ..., vₙ} represents n delivery locations, and each edge (vᵢ, vⱼ) has a weight d(i, j) representing the Euclidean distance between them.",
              font: "Arial",
              size: 22,
              color: BLACK,
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 80, after: 80, line: 320 },
          indent: { left: 720 },
          children: [
            new TextRun({
              text: "Find:     ",
              font: "Arial",
              size: 22,
              bold: true,
              color: BLUE,
            }),
            new TextRun({
              text: "A Hamiltonian cycle H* — a permutation of V — such that the total tour cost Σ d(vᵢ, vᵢ₊₁) is minimized.",
              font: "Arial",
              size: 22,
              color: BLACK,
            }),
          ],
        }),
        spacer(60),
        para("The challenges this project addresses are:"),
        bullet(
          "Brute-force enumeration (O(n!)) is computationally infeasible for even moderate n — for just 20 cities, n! exceeds 2.4 quintillion operations.",
        ),
        bullet(
          "The Held-Karp DP algorithm reduces this to O(n² · 2ⁿ), but still becomes impractical beyond n ≈ 20.",
        ),
        bullet(
          "Practical delivery routing therefore requires heuristic and local-search approximations that trade a small percentage of optimality for massive gains in speed.",
        ),
        bullet(
          "There is a need for a visual, accessible tool that demonstrates these trade-offs interactively.",
        ),

        // ─── 4. OBJECTIVES ───
        spacer(200),
        sectionBox("4. Objectives"),
        spacer(120),
        para("The primary objectives of this project are:"),
        spacer(60),
        numbered(
          "Implement the Held-Karp Dynamic Programming algorithm to compute the exact optimal TSP solution for small instances (n ≤ 15), demonstrating bitmask DP technique.",
        ),
        numbered(
          "Implement the Nearest Neighbor Greedy Heuristic to efficiently produce an approximate solution for any input size in O(n²) time.",
        ),
        numbered(
          "Implement the 2-opt Local Search algorithm to iteratively improve the heuristic tour by reversing sub-paths that eliminate route crossings.",
        ),
        numbered(
          "Perform formal asymptotic complexity analysis (time and space) for each of the three algorithms and present a comparative study.",
        ),
        numbered(
          "Design and develop an interactive visualization interface where users can input delivery locations and observe each algorithm's route-finding process animated in real time.",
        ),
        numbered(
          "Quantify and display the optimality gap (%) of each heuristic relative to the Held-Karp exact solution on benchmark inputs.",
        ),
        numbered(
          "Demonstrate through empirical testing that the heuristic approaches scale to large n while the exact DP solution becomes intractable.",
        ),
        numbered(
          "Document all design decisions, algorithmic derivations, and experimental results in a structured report suitable for academic evaluation.",
        ),

        // ─── 5. PROPOSED METHODOLOGY ───
        spacer(200),
        new Paragraph({ children: [new PageBreak()] }),
        sectionBox("5. Proposed Methodology"),
        spacer(120),

        h2("5.1  System Architecture"),
        para(
          "The project is structured into three logical layers: (1) the Input & Data Layer, which handles city coordinates and distance matrix computation; (2) the Algorithm Engine, containing independent implementations of all three TSP algorithms; and (3) the Visualization & Comparison Layer, which renders the animated route and performance metrics.",
        ),
        spacer(100),

        h2("5.2  Methodology Flowchart"),
        ...imageBlock(
          img1,
          460,
          540,
          "Figure 1: End-to-end project methodology flowchart showing the decision flow between exact and heuristic algorithms",
        ),
        spacer(60),

        h2("5.3  Algorithm Design"),
        spacer(60),
        new Paragraph({
          spacing: { before: 80, after: 40 },
          children: [
            new TextRun({
              text: "Phase 1 — Data Input and Preprocessing",
              font: "Arial",
              size: 22,
              bold: true,
              color: BLUE,
            }),
          ],
        }),
        bullet(
          "Accept city coordinates via user clicks on a canvas, or load a predefined dataset (e.g., major Indian cities with real lat/long).",
        ),
        bullet(
          "Construct an n × n distance matrix D where D[i][j] = Euclidean distance between city i and city j.",
        ),
        bullet(
          "Normalize and validate input; reject degenerate inputs (duplicate cities, n < 3).",
        ),
        spacer(80),
        new Paragraph({
          spacing: { before: 80, after: 40 },
          children: [
            new TextRun({
              text: "Phase 2 — Held-Karp Dynamic Programming (Exact, n ≤ 15)",
              font: "Arial",
              size: 22,
              bold: true,
              color: BLUE,
            }),
          ],
        }),
        para(
          "The Held-Karp algorithm uses bitmask DP. Let dp[S][i] = minimum cost to reach city i, having visited exactly the cities in set S. The recurrence is:",
        ),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 80 },
          indent: { left: 360 },
          children: [
            new TextRun({
              text: "dp[S][i]  =  min over j ∈ S \\ {i}  of  { dp[S \\ {i}][j]  +  D[j][i] }",
              font: "Courier New",
              size: 22,
              color: "1A1A2E",
            }),
          ],
        }),
        bullet("Base case: dp[{0}][0] = 0 (start at city 0, cost 0)."),
        bullet(
          "Final answer: min over i ≠ 0 of { dp[{all cities}][i] + D[i][0] }.",
        ),
        bullet("Time: O(n² · 2ⁿ)   |   Space: O(n · 2ⁿ)."),
        spacer(80),
        new Paragraph({
          spacing: { before: 80, after: 40 },
          children: [
            new TextRun({
              text: "Phase 3 — Nearest Neighbor Heuristic (O(n²))",
              font: "Arial",
              size: 22,
              bold: true,
              color: BLUE,
            }),
          ],
        }),
        bullet("Start from depot (city 0). Mark as visited."),
        bullet("At each step, move to the closest unvisited city."),
        bullet("Repeat until all cities are visited, then return to depot."),
        bullet(
          "Produces a tour approximately 20–25% longer than optimal on average cases.",
        ),
        spacer(80),
        new Paragraph({
          spacing: { before: 80, after: 40 },
          children: [
            new TextRun({
              text: "Phase 4 — 2-opt Local Search Improvement",
              font: "Arial",
              size: 22,
              bold: true,
              color: BLUE,
            }),
          ],
        }),
        bullet("Start with the Nearest Neighbor tour as the initial solution."),
        bullet(
          "Repeatedly select two edges (i, i+1) and (j, j+1) and check if replacing them with (i, j) and (i+1, j+1) reduces total distance.",
        ),
        bullet(
          "If yes, reverse the sub-path between i+1 and j (a '2-opt swap').",
        ),
        bullet(
          "Repeat until no improving swap exists (local optimum reached).",
        ),
        bullet("Reduces tour length by 5–15% compared to the raw greedy tour."),
        spacer(120),

        h2("5.4  Complexity Analysis Table"),
        spacer(60),
        complexityTable(),
        spacer(120),

        h2("5.5  Algorithm Comparison Diagram"),
        ...imageBlock(
          img2,
          580,
          390,
          "Figure 2: Algorithm complexity comparison table and approximate route quality vs speed chart",
        ),
        spacer(60),

        h2("5.6  Implementation Plan"),
        spacer(60),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [900, 4860, 2160, 1440],
          rows: [
            new TableRow({
              children: ["Phase", "Task", "Technology", "Duration"].map(
                (h, i) =>
                  new TableCell({
                    borders,
                    shading: { fill: BLUE, type: ShadingType.CLEAR },
                    width: {
                      size: [900, 4860, 2160, 1440][i],
                      type: WidthType.DXA,
                    },
                    margins: { top: 80, bottom: 80, left: 100, right: 100 },
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [
                          new TextRun({
                            text: h,
                            font: "Arial",
                            size: 20,
                            bold: true,
                            color: WHITE,
                          }),
                        ],
                      }),
                    ],
                  }),
              ),
            }),
            ...[
              [
                "1",
                "Distance matrix & input handling",
                "Python / JavaScript",
                "Week 1",
              ],
              [
                "2",
                "Nearest Neighbor heuristic + visualization",
                "Python (Pygame) / JS Canvas",
                "Week 2",
              ],
              [
                "3",
                "2-opt improvement + animated route update",
                "Python / JS",
                "Week 3",
              ],
              ["4", "Held-Karp DP implementation", "Python", "Week 4"],
              [
                "5",
                "Comparison dashboard & performance metrics",
                "Python / HTML",
                "Week 5",
              ],
              [
                "6",
                "Testing, report writing & documentation",
                "LaTeX / Word",
                "Week 6",
              ],
            ].map(
              ([ph, task, tech, dur], i) =>
                new TableRow({
                  children: [ph, task, tech, dur].map(
                    (cell, j) =>
                      new TableCell({
                        borders,
                        width: {
                          size: [900, 4860, 2160, 1440][j],
                          type: WidthType.DXA,
                        },
                        shading: {
                          fill: i % 2 === 0 ? GRAY : WHITE,
                          type: ShadingType.CLEAR,
                        },
                        margins: { top: 60, bottom: 60, left: 100, right: 100 },
                        children: [
                          new Paragraph({
                            alignment:
                              j === 0
                                ? AlignmentType.CENTER
                                : AlignmentType.LEFT,
                            children: [
                              new TextRun({
                                text: cell,
                                font: "Arial",
                                size: 19,
                                color: BLACK,
                              }),
                            ],
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          ],
        }),

        // ─── 6. EXPECTED RESULTS ───
        spacer(200),
        new Paragraph({ children: [new PageBreak()] }),
        sectionBox("6. Expected Results"),
        spacer(120),

        para(
          "Upon completion of the project, the following outcomes are expected:",
        ),
        spacer(80),

        h2("6.1  Functional Deliverables"),
        bullet(
          "A working interactive application where users place n delivery points and trigger each of the three TSP algorithms.",
        ),
        bullet(
          "Animated visualization of the route being constructed step by step for all three algorithms.",
        ),
        bullet(
          "A live comparison panel showing: total route distance, execution time (ms), and optimality gap (%) relative to Held-Karp.",
        ),
        bullet(
          "Automatic disabling of the Held-Karp solver for n > 15, with a clear message explaining the exponential growth.",
        ),
        spacer(80),

        h2("6.2  Performance Benchmarks (Expected)"),
        spacer(60),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [1800, 1800, 1800, 1980, 1980],
          rows: [
            new TableRow({
              children: [
                "n (Cities)",
                "Brute Force",
                "Held-Karp DP",
                "Nearest Neighbor",
                "2-opt Improved",
              ].map(
                (h, i) =>
                  new TableCell({
                    borders,
                    shading: { fill: BLUE, type: ShadingType.CLEAR },
                    width: {
                      size: [1800, 1800, 1800, 1980, 1980][i],
                      type: WidthType.DXA,
                    },
                    margins: { top: 80, bottom: 80, left: 100, right: 100 },
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [
                          new TextRun({
                            text: h,
                            font: "Arial",
                            size: 19,
                            bold: true,
                            color: WHITE,
                          }),
                        ],
                      }),
                    ],
                  }),
              ),
            }),
            ...[
              ["5", "< 1 ms", "< 1 ms", "< 1 ms", "< 1 ms"],
              ["10", "~3.6M ops", "< 5 ms", "< 1 ms", "< 2 ms"],
              ["15", "Infeasible", "~50–200ms", "< 1 ms", "< 5 ms"],
              ["20", "Infeasible", "Infeasible", "< 1 ms", "< 10 ms"],
              ["50", "Infeasible", "Infeasible", "< 5 ms", "< 50 ms"],
            ].map(
              (row, i) =>
                new TableRow({
                  children: row.map(
                    (cell, j) =>
                      new TableCell({
                        borders,
                        width: {
                          size: [1800, 1800, 1800, 1980, 1980][j],
                          type: WidthType.DXA,
                        },
                        shading: {
                          fill: i % 2 === 0 ? GRAY : WHITE,
                          type: ShadingType.CLEAR,
                        },
                        margins: { top: 60, bottom: 60, left: 100, right: 100 },
                        children: [
                          new Paragraph({
                            alignment: AlignmentType.CENTER,
                            children: [
                              new TextRun({
                                text: cell,
                                font: "Arial",
                                size: 19,
                                color: BLACK,
                              }),
                            ],
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          ],
        }),
        spacer(100),

        h2("6.3  Quality Metrics"),
        bullet(
          "Held-Karp will consistently produce the optimal tour (100% quality baseline) for all test inputs with n ≤ 15.",
        ),
        bullet(
          "Nearest Neighbor is expected to produce tours within 20–28% of optimal on random Euclidean instances.",
        ),
        bullet(
          "2-opt improvement is expected to reduce the Nearest Neighbor gap to within 5–15% of optimal.",
        ),
        bullet(
          "Execution time will demonstrate exponential growth for Held-Karp vs. near-constant polynomial growth for heuristics.",
        ),
        spacer(80),

        h2("6.4  Academic Outcomes"),
        bullet(
          "Deep understanding of NP-Hard problem formulation and why TSP cannot be solved in polynomial time (unless P = NP).",
        ),
        bullet(
          "Practical mastery of bitmask Dynamic Programming, a technique widely used in competitive programming.",
        ),
        bullet(
          "Hands-on experience with approximation algorithm design and the concept of an approximation ratio.",
        ),
        bullet(
          "A portfolio-ready, visually impressive project demonstrating end-to-end software engineering skills.",
        ),

        // ─── 7. CONCLUSION ───
        spacer(200),
        sectionBox("7. Conclusion"),
        spacer(120),

        para(
          "The Delivery Route Optimizer project directly demonstrates the central tension at the heart of algorithm design: the trade-off between solution optimality and computational tractability. By implementing three fundamentally different approaches — an exact DP algorithm, a greedy heuristic, and a local search improvement — students gain concrete, hands-on experience with concepts that are otherwise purely theoretical in a classroom setting.",
        ),
        spacer(80),
        para(
          "The project covers a wide range of core DAA topics within a single coherent system: dynamic programming (Held-Karp), greedy algorithm design (Nearest Neighbor), local search and iterative improvement (2-opt), graph theory (Hamiltonian cycle), and asymptotic complexity analysis across all three paradigms. This breadth makes it particularly well-suited as a DAA course project.",
        ),
        spacer(80),
        para(
          "Beyond academia, the Travelling Salesman Problem has direct, high-value applications in logistics, supply chain management, circuit board drilling, DNA sequencing, and robotics path planning. The project therefore bridges theoretical computer science and real-world engineering — demonstrating not just what algorithms do, but why the choice of algorithm fundamentally shapes what is computationally possible.",
        ),
        spacer(80),
        para(
          "Upon completion, this project will produce a working, interactive application with a clear visual interface, a rigorous comparative analysis, and a comprehensive technical report — all of which constitute a strong academic submission and a meaningful portfolio artifact for industry placements.",
        ),
        spacer(200),

        // References
        sectionBox("References"),
        spacer(100),
        numbered(
          "Cormen, T. H., Leiserson, C. E., Rivest, R. L., & Stein, C. (2009). Introduction to Algorithms (3rd ed.). MIT Press.",
        ),
        numbered(
          "Held, M., & Karp, R. M. (1962). A Dynamic Programming Approach to Sequencing Problems. Journal of the Society for Industrial and Applied Mathematics, 10(1), 196–210.",
        ),
        numbered(
          "Lin, S., & Kernighan, B. W. (1973). An Effective Heuristic Algorithm for the Travelling Salesman Problem. Operations Research, 21(2), 498–516.",
        ),
        numbered(
          "Applegate, D. L., Bixby, R. E., Chvátal, V., & Cook, W. J. (2006). The Traveling Salesman Problem: A Computational Study. Princeton University Press.",
        ),
        numbered(
          "GeeksforGeeks. (2024). Travelling Salesman Problem using Dynamic Programming. https://www.geeksforgeeks.org/travelling-salesman-problem-set-1/",
        ),
        numbered(
          "Wikipedia. (2025). 2-opt. https://en.wikipedia.org/wiki/2-opt",
        ),
      ],
    },
  ],
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync("/home/claude/synopsis_TSP.docx", buffer);
  console.log("Done: synopsis_TSP.docx");
});
