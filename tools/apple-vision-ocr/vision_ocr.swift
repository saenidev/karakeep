// Reads the text in an image with Apple's Vision framework (macOS only).
// Usage: vision_ocr < image
//   -> {"text": "...", "confidence": 0.93} on stdout, where confidence is the
//      character-weighted mean of the recognized lines' confidence (0 if none).
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
let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
let chars = candidates.reduce(0) { $0 + $1.string.count }
let weighted = candidates.reduce(0.0) { $0 + Double($1.confidence) * Double($1.string.count) }
let output: [String: Any] = [
    "text": candidates.map(\.string).joined(separator: "\n"),
    "confidence": chars > 0 ? weighted / Double(chars) : 0,
]
let json = try JSONSerialization.data(withJSONObject: output)
FileHandle.standardOutput.write(json)
