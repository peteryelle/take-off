# Take-Off

A schematic drawing take-off application for efficient material estimation and quantity extraction from architectural and construction drawings.

## Overview

Take-Off is a web-based application designed to streamline the process of extracting measurements and quantities from schematic drawings. Whether you're working with architectural blueprints, construction plans, or technical schematics, this tool helps you quickly and accurately perform take-offs.

## Features

- 📐 Interactive drawing viewer
- 📋 Measurement tools for schematic analysis
- 📊 Quantity tracking and reporting
- 💾 Project management capabilities
- 🖥️ Intuitive web-based interface

## Technology Stack

- **Frontend**: JavaScript (56.8%) - Core application logic and interactivity
- **Markup**: HTML (43.2%) - Semantic structure and layout

## Getting Started

### Prerequisites

- A modern web browser (Chrome, Firefox, Safari, or Edge)
- Internet connection

### Installation
1. Clone the repository:
```bash
git clone https://github.com/peteryelle/take-off.git
cd take-off
```

2. Open The application in your browser
```bash
# Simply open index.html in your browser, or
# Use a local server (recommended):
python -m http.server 8000
# Then navigate to http://localhost:8000
```

3. Running Tests
```bash
#runs all tests in /tests
npm test
```

### Useage 
1. Load a Drawing: Import or open a schematic drawing file
2. Create Measurements: Use the measurement tools to extract quantities
3. Track Items: Add and manage all items needed for your project
4. Generate Reports: Export your take-off data for further analysis

### Project Structure:
```code
take-off/
├── index.html          # Main application entry point
├── assets/             # Images, fonts, and static files
├── js/                 # JavaScript application logic
├── css/                # Stylesheets
├── tests/              # Tests
└── README.md           # This file
```