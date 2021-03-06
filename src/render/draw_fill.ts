import Color from '../style-spec/util/color';
import DepthMode from '../gl/depth_mode';
import CullFaceMode from '../gl/cull_face_mode';
import {
    fillUniformValues,
    fillPatternUniformValues,
    fillOutlineUniformValues,
    fillOutlinePatternUniformValues,
    fillfboUniformValues
} from './program/fill_program';

import type Painter from './painter';
import type SourceCache from '../source/source_cache';
import type FillStyleLayer from '../style/style_layer/fill_style_layer';
import type FillBucket from '../data/bucket/fill_bucket';
import type {OverscaledTileID} from '../source/tile_id';
import ColorMode from '../gl/color_mode';
import StencilMode from '../gl/stencil_mode';

export default drawFill;

function drawFill(painter: Painter, sourceCache: SourceCache, layer: FillStyleLayer, coords: Array<OverscaledTileID>) {
    const color = layer.paint.get('fill-color');
    const opacity = layer.paint.get('fill-opacity');

    if (opacity.constantOr(1) === 0) {
        return;
    }

    let colorMode = painter.colorModeForRenderPass();

    const pattern = layer.paint.get('fill-pattern');
    const pass = painter.opaquePassEnabledForLayer() &&
        (!pattern.constantOr(1 as any) &&
        color.constantOr(Color.transparent).a === 1 &&
        opacity.constantOr(0) === 1) ? 'opaque' : 'translucent';

    const gl = painter.context.gl;
    // offscreen
    if (painter.renderPass === 'offscreen') {
        // prepare fbo
        const context = painter.context;
        // Turn on additive blending for kernels, which is a key aspect of kernel density estimation formula
        colorMode = new ColorMode([gl.ONE, gl.ZERO], Color.transparent, [true, true, true, true]);
        bindFramebuffer(context, painter, layer);
        context.clear({color: Color.transparent});

        // Draw fill
        const depthMode = DepthMode.disabled;
        drawFillTiles(painter, sourceCache, layer, coords, depthMode, colorMode, false, StencilMode.disabled);
        context.viewport.set([0, 0, painter.width, painter.height]);
    } else if (painter.renderPass === 'translucent') {
        const context = painter.context;
        context.setColorMode(painter.colorModeForRenderPass());

        const fbo = layer.fillFbo;
        if (!fbo) return;
        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());
    
        const opacity = 0.5;
        const textureUnit = 0;
        const uniformValues = fillfboUniformValues(painter, textureUnit, opacity);
        painter.useProgram('fillfbo').draw(context, gl.TRIANGLES,
            DepthMode.disabled, StencilMode.disabled, painter.colorModeForRenderPass(), CullFaceMode.disabled,
            uniformValues,
            layer.id, painter.viewportBuffer, painter.quadTriangleIndexBuffer,
            painter.viewportSegments, layer.paint, painter.transform.zoom);
    }

    // Ignore Draw stroke
    // if (painter.renderPass === 'translucent' && layer.paint.get('fill-antialias')) {

    //     // If we defined a different color for the fill outline, we are
    //     // going to ignore the bits in 0x07 and just care about the global
    //     // clipping mask.
    //     // Otherwise, we only want to drawFill the antialiased parts that are
    //     // *outside* the current shape. This is important in case the fill
    //     // or stroke color is translucent. If we wouldn't clip to outside
    //     // the current shape, some pixels from the outline stroke overlapped
    //     // the (non-antialiased) fill.
    //     const depthMode = painter.depthModeForSublayer(
    //         layer.getPaintProperty('fill-outline-color') ? 2 : 0, DepthMode.ReadOnly);
    //     drawFillTiles(painter, sourceCache, layer, coords, depthMode, colorMode, true, painter.stencilModeForClipping(coord));
    // }
}

function drawFillTiles(painter, sourceCache, layer, coords, depthMode, colorMode, isOutline, stencilMode) {
    const gl = painter.context.gl;

    const patternProperty = layer.paint.get('fill-pattern');
    const image = patternProperty && patternProperty.constantOr(1 as any);
    const crossfade = layer.getCrossfadeParameters();
    let drawMode, programName, uniformValues, indexBuffer, segments;

    if (!isOutline) {
        programName = image ? 'fillPattern' : 'fill';
        drawMode = gl.TRIANGLES;
    } else {
        programName = image && !layer.getPaintProperty('fill-outline-color') ? 'fillOutlinePattern' : 'fillOutline';
        drawMode = gl.LINES;
    }

    for (const coord of coords) {
        const tile = sourceCache.getTile(coord);
        if (image && !tile.patternsLoaded()) continue;

        const bucket: FillBucket = (tile.getBucket(layer) as any);
        if (!bucket) continue;

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = painter.useProgram(programName, programConfiguration);

        if (image) {
            painter.context.activeTexture.set(gl.TEXTURE0);
            tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            programConfiguration.updatePaintBuffers(crossfade);
        }

        const constantPattern = patternProperty.constantOr(null);
        if (constantPattern && tile.imageAtlas) {
            const atlas = tile.imageAtlas;
            const posTo = atlas.patternPositions[constantPattern.to.toString()];
            const posFrom = atlas.patternPositions[constantPattern.from.toString()];
            if (posTo && posFrom) programConfiguration.setConstantPatternPositions(posTo, posFrom);
        }

        const tileMatrix = painter.translatePosMatrix(coord.posMatrix, tile,
            layer.paint.get('fill-translate'), layer.paint.get('fill-translate-anchor'));

        if (!isOutline) {
            indexBuffer = bucket.indexBuffer;
            segments = bucket.segments;
            uniformValues = image ?
                fillPatternUniformValues(tileMatrix, painter, crossfade, tile) :
                fillUniformValues(tileMatrix);
        } else {
            indexBuffer = bucket.indexBuffer2;
            segments = bucket.segments2;
            const drawingBufferSize = [gl.drawingBufferWidth, gl.drawingBufferHeight] as [number, number];
            uniformValues = (programName === 'fillOutlinePattern' && image) ?
                fillOutlinePatternUniformValues(tileMatrix, painter, crossfade, tile, drawingBufferSize) :
                fillOutlineUniformValues(tileMatrix, drawingBufferSize);
        }

        program.draw(painter.context, drawMode, depthMode,
            stencilMode, colorMode, CullFaceMode.disabled, uniformValues,
            layer.id, bucket.layoutVertexBuffer, indexBuffer, segments,
            layer.paint, painter.transform.zoom, programConfiguration);
    }
}

function bindFramebuffer(context, painter, layer) {
    const gl = context.gl;
    context.activeTexture.set(gl.TEXTURE1);

    context.viewport.set([0, 0, painter.width, painter.height]);

    let fbo = layer.fillFbo;

    if (!fbo) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        fbo = layer.fillFbo = context.createFramebuffer(painter.width, painter.height, false);

        bindTextureToFramebuffer(context, painter, texture, fbo);

    } else {
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());
        context.bindFramebuffer.set(fbo.framebuffer);
    }
}

function bindTextureToFramebuffer(context, painter, texture, fbo) {
    const gl = context.gl;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, painter.width, painter.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    fbo.colorAttachment.set(texture);
}