#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) {
            fprintf(stderr, "usage: sn_ocr IMAGE_PATH\n");
            return 2;
        }

        NSString *path = [NSString stringWithUTF8String:argv[1]];
        NSURL *url = [NSURL fileURLWithPath:path];
        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = NO;
        request.minimumTextHeight = 0.008;

        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc]
            initWithURL:url options:@{}];
        NSError *performError = nil;
        BOOL ok = [handler performRequests:@[request] error:&performError];
        if (!ok || performError) {
            const char *message = performError ? performError.localizedDescription.UTF8String : "unknown error";
            fprintf(stderr, "Vision OCR failed: %s\n", message);
            return 4;
        }

        for (VNRecognizedTextObservation *observation in request.results ?: @[]) {
            VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
            if (!candidate) continue;
            NSString *text = [candidate.string stringByReplacingOccurrencesOfString:@"\t" withString:@" "];
            printf("%.4f\t%s\n", candidate.confidence, text.UTF8String);
        }
    }
    return 0;
}
