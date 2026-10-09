// Reads the text in an image with Apple's Vision framework (macOS only).
// Usage: vision_ocr < image   -> recognized text lines on stdout.
// Build: swiftc -O vision_ocr.swift -o vision_ocr
import Foundation
import Vision

let data = FileHandle.standardInput.readDataToEndOfFile()
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.automaticallyDetectsLanguage = true
do {
    try VNImageRequestHandler(data: data).perform([request])
} catch {
    FileHandle.standardError.write("vision_ocr: \(error)\n".data(using: .utf8)!)
    exit(1)
}
let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
