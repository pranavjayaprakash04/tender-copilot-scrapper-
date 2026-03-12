#!/usr/bin/env python3
"""
TenderPilot CAPTCHA Solver
Primary: TrOCR (Microsoft transformer OCR - much better on distorted text)
Fallback: ddddocr
Fallback 2: pytesseract
"""
import sys
import os
import base64
import json
from io import BytesIO


def preprocess_image(image_bytes):
    try:
        from PIL import Image, ImageFilter, ImageEnhance, ImageOps
        img = Image.open(BytesIO(image_bytes)).convert('L')  # grayscale
        w, h = img.size
        img = img.resize((w * 3, h * 3), Image.LANCZOS)
        img = ImageEnhance.Contrast(img).enhance(3.0)
        img = ImageOps.autocontrast(img)
        img = img.filter(ImageFilter.SHARPEN)
        out = BytesIO()
        img.save(out, format='PNG')
        return out.getvalue()
    except Exception:
        return image_bytes


def solve_with_trocr(image_bytes):
    """
    Use Microsoft TrOCR - transformer trained specifically on printed/handwritten text.
    Much better than ddddocr on NIC-style distorted captchas.
    Downloads ~1GB model on first run, cached after that.
    """
    from transformers import TrOCRProcessor, VisionEncoderDecoderModel
    from PIL import Image
    import torch

    processor = TrOCRProcessor.from_pretrained('microsoft/trocr-base-printed')
    model = VisionEncoderDecoderModel.from_pretrained('microsoft/trocr-base-printed')
    model.eval()

    img = Image.open(BytesIO(image_bytes)).convert('RGB')
    # Upscale for better recognition
    w, h = img.size
    img = img.resize((max(w * 2, 200), max(h * 2, 80)))

    pixel_values = processor(images=img, return_tensors='pt').pixel_values
    with torch.no_grad():
        generated_ids = model.generate(pixel_values)
    result = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
    # Strip spaces and non-alphanumeric chars typical in captcha results
    return ''.join(c for c in result if c.isalnum())


def solve_with_ddddocr(image_bytes):
    import ddddocr
    ocr = ddddocr.DdddOcr(show_ad=False)
    result = ocr.classification(image_bytes)
    return result.strip()


def solve_with_tesseract(image_bytes):
    import pytesseract
    from PIL import Image
    img = Image.open(BytesIO(image_bytes))
    config = '--psm 8 --oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    result = pytesseract.image_to_string(img, config=config)
    return result.strip().replace(' ', '')


def solve_from_base64(b64_string):
    image_bytes = base64.b64decode(b64_string)
    enhanced = preprocess_image(image_bytes)

    # Try 1: TrOCR on enhanced image (best for NIC captchas)
    try:
        answer = solve_with_trocr(enhanced)
        if answer:
            return answer, 'trocr-enhanced'
    except Exception as e:
        pass

    # Try 2: TrOCR on original
    try:
        answer = solve_with_trocr(image_bytes)
        if answer:
            return answer, 'trocr-original'
    except Exception as e:
        pass

    # Try 3: ddddocr on enhanced
    try:
        answer = solve_with_ddddocr(enhanced)
        if answer:
            return answer, 'ddddocr-enhanced'
    except Exception:
        pass

    # Try 4: ddddocr on original
    try:
        answer = solve_with_ddddocr(image_bytes)
        if answer:
            return answer, 'ddddocr-original'
    except Exception:
        pass

    # Try 5: pytesseract
    try:
        answer = solve_with_tesseract(enhanced)
        if answer:
            return answer, 'tesseract'
    except Exception:
        pass

    return '', 'none'


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
            answer, method = solve_from_file(input_val)
        else:
            answer, method = solve_from_base64(input_val)

        print(json.dumps({"success": True, "answer": answer, "method": method}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
