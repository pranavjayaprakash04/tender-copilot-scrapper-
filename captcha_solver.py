#!/usr/bin/env python3
"""
TenderPilot CAPTCHA Solver
Tries ddddocr first, then falls back to pytesseract with image preprocessing.
"""
import sys
import os
import base64
import json
from io import BytesIO

def preprocess_image(image_bytes):
    """Enhance image contrast and size for better OCR accuracy."""
    try:
        from PIL import Image, ImageFilter, ImageEnhance
        img = Image.open(BytesIO(image_bytes)).convert('L')  # grayscale
        # Upscale for better OCR
        w, h = img.size
        img = img.resize((w * 3, h * 3), Image.LANCZOS)
        # Increase contrast
        img = ImageEnhance.Contrast(img).enhance(2.5)
        # Sharpen
        img = img.filter(ImageFilter.SHARPEN)
        # Convert back to bytes
        out = BytesIO()
        img.save(out, format='PNG')
        return out.getvalue()
    except Exception as e:
        return image_bytes  # return original if preprocessing fails

def solve_with_ddddocr(image_bytes):
    import ddddocr
    ocr = ddddocr.DdddOcr(show_ad=False)
    result = ocr.classification(image_bytes)
    return result.strip()

def solve_with_tesseract(image_bytes):
    import pytesseract
    from PIL import Image
    img = Image.open(BytesIO(image_bytes))
    # Config for short alphanumeric captchas
    config = '--psm 8 --oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    result = pytesseract.image_to_string(img, config=config)
    return result.strip().replace(' ', '')

def solve_from_base64(b64_string):
    image_bytes = base64.b64decode(b64_string)
    enhanced = preprocess_image(image_bytes)

    # Try 1: ddddocr on original
    try:
        answer = solve_with_ddddocr(image_bytes)
        if answer:
            return answer
    except Exception:
        pass

    # Try 2: ddddocr on enhanced
    try:
        answer = solve_with_ddddocr(enhanced)
        if answer:
            return answer
    except Exception:
        pass

    # Try 3: pytesseract on enhanced
    try:
        answer = solve_with_tesseract(enhanced)
        if answer:
            return answer
    except Exception:
        pass

    # Try 4: pytesseract on original
    try:
        answer = solve_with_tesseract(image_bytes)
        if answer:
            return answer
    except Exception:
        pass

    return ''

def solve_from_file(image_path):
    with open(image_path, 'rb') as f:
        image_bytes = f.read()
    b64 = base64.b64encode(image_bytes).decode()
    return solve_from_base64(b64)

if __name__ == '__main__':
    try:
        if len(sys.argv) < 2:
            print(json.dumps({"error": "No input provided"}))
            sys.exit(1)

        input_val = sys.argv[1]

        if os.path.exists(input_val):
            answer = solve_from_file(input_val)
        else:
            answer = solve_from_base64(input_val)

        print(json.dumps({"success": True, "answer": answer}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
