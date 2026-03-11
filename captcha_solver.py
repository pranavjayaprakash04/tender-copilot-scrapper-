#!/usr/bin/env python3
"""
TenderPilot CAPTCHA Solver
Uses ddddocr — open source, runs fully locally, zero cost.
Called by Node.js scrapers via child_process.
Usage: python3 captcha_solver.py <image_path>
"""

import sys
import os
import ddddocr
import base64
import json

def solve_from_file(image_path):
    """Solve CAPTCHA from a file path"""
    ocr = ddddocr.DdddOcr(show_ad=False)
    with open(image_path, 'rb') as f:
        image_bytes = f.read()
    result = ocr.classification(image_bytes)
    return result.strip()

def solve_from_base64(b64_string):
    """Solve CAPTCHA from base64 encoded image"""
    ocr = ddddocr.DdddOcr(show_ad=False)
    image_bytes = base64.b64decode(b64_string)
    result = ocr.classification(image_bytes)
    return result.strip()

if __name__ == '__main__':
    try:
        if len(sys.argv) < 2:
            print(json.dumps({"error": "No input provided"}))
            sys.exit(1)

        input_val = sys.argv[1]

        # Detect if input is a file path or base64
        if os.path.exists(input_val):
            answer = solve_from_file(input_val)
        else:
            answer = solve_from_base64(input_val)

        print(json.dumps({"success": True, "answer": answer}))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
