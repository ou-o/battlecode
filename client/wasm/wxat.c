// wxat.c - WeChat mini program WASM wrapper for AprilTag 25h9 detection.
//
// Exposes a tiny C ABI consumed from JS via WXWebAssembly:
//   int  wxat_init(void)               // creates detector, loads 25h9 family
//   void wxat_set_decimate(float)
//   int  wxat_detect_rgba(const uint8_t *rgba, int w, int h, float *out, int maxdets)
//   void wxat_shutdown(void)
//
// Only the 25h9 family is compiled in; no family switching at runtime.
//
// Output layout written to `out` (float32):
//   out[0] = number of detections (<= maxdets)
//   then, per detection (11 floats):
//     id, cx, cy, p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y
//   (corners are counter-clockwise, starting at the (-1,-1) tag corner)

#include <stdint.h>
#include <stdlib.h>

#include "apriltag.h"
#include "tag25h9.h"
#include "common/image_u8.h"
#include "common/zarray.h"

static apriltag_detector_t *g_td = NULL;
static apriltag_family_t   *g_tf = NULL;

int wxat_init(void)
{
    if (g_td)
        return 0;

    g_td = apriltag_detector_create();
    if (!g_td)
        return -1;

    g_td->nthreads      = 1;     // workerpool runs inline; no pthreads in WASM
    g_td->quad_decimate = 2.0f;  // detect quads at half resolution (speed)
    g_td->quad_sigma    = 0.0f;
    g_td->refine_edges  = 1;
    g_td->debug         = 0;

    g_tf = tag25h9_create();
    if (!g_tf) {
        apriltag_detector_destroy(g_td);
        g_td = NULL;
        return -2;
    }
    apriltag_detector_add_family(g_td, g_tf);
    return 0;
}

void wxat_set_decimate(float d)
{
    if (g_td && d >= 1.0f)
        g_td->quad_decimate = d;
}

int wxat_detect_rgba(const uint8_t *rgba, int w, int h, float *out, int maxdets)
{
    if (!g_td || !rgba || !out || w < 8 || h < 8)
        return -1;

    image_u8_t *im = image_u8_create(w, h);
    if (!im)
        return -2;

    // RGBA -> grayscale (ITU-R 601-2 luma, fixed point)
    for (int y = 0; y < h; y++) {
        const uint8_t *src = rgba + (size_t) y * (size_t) w * 4u;
        uint8_t *dst = im->buf + (size_t) y * (size_t) im->stride;
        for (int x = 0; x < w; x++) {
            uint32_t r = src[4 * x + 0];
            uint32_t g = src[4 * x + 1];
            uint32_t b = src[4 * x + 2];
            dst[x] = (uint8_t)((r * 77u + g * 150u + b * 29u) >> 8);
        }
    }

    zarray_t *dets = apriltag_detector_detect(g_td, im);

    int n = zarray_size(dets);
    if (n > maxdets)
        n = maxdets;

    out[0] = (float) n;
    int o = 1;
    for (int i = 0; i < n; i++) {
        apriltag_detection_t *det;
        zarray_get(dets, i, &det);
        out[o++] = (float) det->id;
        out[o++] = (float) det->c[0];
        out[o++] = (float) det->c[1];
        for (int j = 0; j < 4; j++) {
            out[o++] = (float) det->p[j][0];
            out[o++] = (float) det->p[j][1];
        }
    }

    apriltag_detections_destroy(dets);
    image_u8_destroy(im);
    return 0;
}

void wxat_shutdown(void)
{
    if (g_td) {
        apriltag_detector_destroy(g_td);
        g_td = NULL;
    }
    if (g_tf) {
        tag25h9_destroy(g_tf);
        g_tf = NULL;
    }
}