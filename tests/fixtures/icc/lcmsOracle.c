#include <lcms2.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 6 && argc != 7) return 2;
  const int inputReference = argc == 7;
  cmsHPROFILE source = cmsOpenProfileFromFile(argv[1], "r");
  cmsHPROFILE destination = cmsOpenProfileFromFile(argv[2], "r");
  cmsHPROFILE lab = cmsCreateLab4Profile(NULL);
  if (!source || !destination || !lab) return 3;
  unsigned intent = (unsigned)atoi(argv[3]);
  cmsUInt32Number flags = cmsFLAGS_NOOPTIMIZE | (atoi(argv[4]) ? cmsFLAGS_BLACKPOINTCOMPENSATION : 0);
  cmsHTRANSFORM convert = cmsCreateTransform(source, TYPE_RGB_DBL, destination, TYPE_CMYK_DBL, intent, flags);
  cmsHTRANSFORM toLab = cmsCreateTransform(destination, TYPE_CMYK_DBL, lab, TYPE_Lab_DBL, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_NOOPTIMIZE);
  if (!convert || !toLab) return 4;
  FILE *input = fopen(argv[5], "r");
  if (!input) return 7;
  size_t count = 0;
  double maximum = 0, total = 0, channelMaximum = 0;
  for (;;) {
    double rgb[3], actual[4], expected[4];
    int scanned;
    if (inputReference) {
      scanned = fscanf(input, "%lf %lf %lf %lf %lf %lf %lf %lf %lf %lf %lf", &rgb[0], &rgb[1], &rgb[2], &actual[0], &actual[1], &actual[2], &actual[3], &expected[0], &expected[1], &expected[2], &expected[3]);
    } else {
      scanned = fscanf(input, "%lf %lf %lf %lf %lf %lf %lf", &rgb[0], &rgb[1], &rgb[2], &actual[0], &actual[1], &actual[2], &actual[3]);
    }
    if (scanned == EOF) break;
    if (scanned != (inputReference ? 11 : 7)) return 5;
    if (!inputReference) cmsDoTransform(convert, rgb, expected, 1);
    // NOOPTIMIZE skips LittleCMS's white endpoint fix; apply that endpoint to the reference values.
    if (intent != INTENT_ABSOLUTE_COLORIMETRIC && rgb[0] == 1 && rgb[1] == 1 && rgb[2] == 1) {
      for (int channel = 0; channel < 4; channel++) expected[channel] = 0;
    }
    cmsCIELab actualLab, expectedLab;
    cmsDoTransform(toLab, actual, &actualLab, 1);
    cmsDoTransform(toLab, expected, &expectedLab, 1);
    double difference = cmsCIE2000DeltaE(&actualLab, &expectedLab, 1, 1, 1);
    if (difference > maximum) maximum = difference;
    total += difference;
    for (int channel = 0; channel < 4; channel++) {
      double delta = fabs(actual[channel] - expected[channel]);
      if (delta > channelMaximum) channelMaximum = delta;
    }
    count++;
  }
  if (count == 0) return 6;
  fclose(input);
  printf("%zu %.9f %.9f %.9f\n", count, maximum, total / (double)count, channelMaximum);
  cmsDeleteTransform(toLab);
  cmsDeleteTransform(convert);
  cmsCloseProfile(lab);
  cmsCloseProfile(destination);
  cmsCloseProfile(source);
  return 0;
}
