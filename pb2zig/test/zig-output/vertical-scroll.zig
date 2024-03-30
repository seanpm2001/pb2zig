// Pixel Bender kernel "Scroll" (translated using pb2zig)
const std = @import("std");

pub const kernel = struct {
    // kernel information
    pub const namespace = "www.tbyrne.org";
    pub const vendor = "Tom Byrne";
    pub const version = 1;
    pub const parameters = .{
        .topRollRadius = .{
            .type = f32,
            .minValue = 0.0,
            .maxValue = 1000.0,
            .defaultValue = 100.0,
            .displayName = "Top Roll Radius",
        },
        .bottomRollRadius = .{
            .type = f32,
            .minValue = 0.0,
            .maxValue = 1000.0,
            .defaultValue = 100.0,
            .displayName = "Bottom Roll Radius",
        },
        .rollHeight = .{
            .type = f32,
            .minValue = 0.0,
            .maxValue = 1000.0,
            .defaultValue = 500.0,
            .displayName = "Roll Height",
        },
        .rollOffsetY = .{
            .type = f32,
            .minValue = 0.0,
            .maxValue = 1000.0,
            .defaultValue = 0.0,
            .displayName = "Roll Offset Y",
        },
        .rollWidth = .{
            .type = f32,
            .minValue = 0.0,
            .maxValue = 1000.0,
            .defaultValue = 500.0,
            .displayName = "Roll Width",
        },
        .rollOffsetX = .{
            .type = f32,
            .minValue = 0.0,
            .maxValue = 1000.0,
            .defaultValue = 0.0,
            .displayName = "Roll Offset X",
        },
        .fogColour = .{
            .type = @Vector(3, f32),
            .minValue = .{ 0.0, 0.0, 0.0 },
            .maxValue = .{ 0.0, 0.0, 0.0 },
            .defaultValue = .{ 0.0, 0.0, 0.0 },
            .parameterType = "colorRGB",
            .displayName = "Fog Colour",
        },
        .fogInfluence = .{
            .type = f32,
            .minValue = 0.0,
            .maxValue = 10.0,
            .defaultValue = 1.0,
            .displayName = "Fog Influence",
        },
        .fade = .{
            .type = f32,
            .minValue = 0.0,
            .maxValue = 10.0,
            .defaultValue = 1.0,
            .displayName = "Fade",
        },
    };
    pub const inputImages = .{
        .src = .{ .channels = 4 },
    };
    pub const outputImages = .{
        .dst = .{ .channels = 4 },
    };

    // generic kernel instance type
    fn Instance(comptime InputStruct: type, comptime OutputStruct: type, comptime ParameterStruct: type) type {
        return struct {
            params: ParameterStruct,
            input: InputStruct,
            output: OutputStruct,
            outputCoord: @Vector(2, u32) = @splat(0),

            // output pixel
            dst: @Vector(4, f32) = undefined,

            // functions defined in kernel
            pub fn evaluatePixel(self: *@This()) void {
                const topRollRadius = self.params.topRollRadius;
                const bottomRollRadius = self.params.bottomRollRadius;
                const rollHeight = self.params.rollHeight;
                const rollOffsetY = self.params.rollOffsetY;
                const rollWidth = self.params.rollWidth;
                const rollOffsetX = self.params.rollOffsetX;
                const fogColour = self.params.fogColour;
                const fogInfluence = self.params.fogInfluence;
                const fade = self.params.fade;
                const src = self.input.src;
                const dst = self.output.dst;
                self.dst = @splat(0.0);

                const pi: f32 = 3.14159265358979;
                const pos: @Vector(2, f32) = self.outCoord();
                var yFract: f32 = undefined;
                var xFract: f32 = undefined;
                var yDir: f32 = undefined;
                var rollRadius: f32 = undefined;
                var doRoll: bool = undefined;
                if (pos[1] < rollOffsetY or pos[1] > rollOffsetY + rollHeight or pos[0] < rollOffsetX or pos[0] > rollOffsetX + rollWidth) {
                    self.dst = @Vector(4, f32){ 0.0, 0.0, 0.0, 0.0 };
                    doRoll = false;
                } else if (pos[1] < rollOffsetY + topRollRadius) {
                    doRoll = true;
                    yFract = 1.0 - ((pos[1] - rollOffsetY) / topRollRadius);
                    xFract = (pos[0] - rollOffsetX - rollWidth / 2.0) / (rollWidth / 2.0);
                    yDir = -1.0;
                    rollRadius = topRollRadius;
                } else if (pos[1] > rollOffsetY + rollHeight - bottomRollRadius) {
                    doRoll = true;
                    yFract = ((pos[1] - (rollOffsetY + rollHeight - bottomRollRadius)) / bottomRollRadius);
                    xFract = (pos[0] - rollOffsetX - rollWidth / 2.0) / (rollWidth / 2.0);
                    yDir = 1.0;
                    rollRadius = bottomRollRadius;
                } else {
                    doRoll = false;
                    self.dst = src.sampleNearest(pos);
                }
                if (doRoll) {
                    const ySin: f32 = 1.0 - sqrt(1.0 - (yFract * yFract));
                    const rollVisible: f32 = rollRadius * pi / 2.0;
                    const posX: f32 = pos[0] + (xFract * ySin * rollRadius);
                    if (posX > rollOffsetX and posX < rollOffsetX + rollWidth) {
                        var colour: @Vector(4, f32) = src.sampleNearest(@Vector(2, f32){
                            posX,
                            pos[1] + ySin * rollVisible * yDir,
                        });
                        if (fogInfluence > 0.0) {
                            const inf: f32 = fogInfluence * ySin;
                            const invInf: f32 = 1.0 - inf;
                            colour[0] = colour[0] * invInf + fogColour[0] * inf;
                            colour[1] = colour[1] * invInf + fogColour[1] * inf;
                            colour[2] = colour[2] * invInf + fogColour[2] * inf;
                        }
                        if (fade > 0.0) {
                            colour[3] *= (1.0 - fade * ySin);
                        }
                        self.dst = colour;
                    } else {
                        self.dst = @Vector(4, f32){ 0.0, 0.0, 0.0, 0.0 };
                    }
                }

                dst.setPixel(self.outputCoord[0], self.outputCoord[1], self.dst);
            }

            pub fn outCoord(self: *@This()) @Vector(2, f32) {
                return .{ @as(f32, @floatFromInt(self.outputCoord[0])) + 0.5, @as(f32, @floatFromInt(self.outputCoord[1])) + 0.5 };
            }
        };
    }

    // kernel instance creation function
    pub fn create(input: anytype, output: anytype, params: anytype) Instance(@TypeOf(input), @TypeOf(output), @TypeOf(params)) {
        return .{
            .input = input,
            .output = output,
            .params = params,
        };
    }

    // built-in Pixel Bender functions
    fn sqrt(v: anytype) @TypeOf(v) {
        return @sqrt(v);
    }
};

pub const Input = KernelInput(u8, kernel);
pub const Output = KernelOutput(u8, kernel);
pub const Parameters = KernelParameters(kernel);

// support both 0.11 and 0.12
const enum_auto = if (@hasField(std.builtin.Type.ContainerLayout, "Auto")) .Auto else .auto;

pub fn createOutput(allocator: std.mem.Allocator, width: u32, height: u32, input: Input, params: Parameters) !Output {
    return createPartialOutput(allocator, width, height, 0, height, input, params);
}

pub fn createPartialOutput(allocator: std.mem.Allocator, width: u32, height: u32, start: u32, count: u32, input: Input, params: Parameters) !Output {
    var output: Output = undefined;
    inline for (std.meta.fields(Output)) |field| {
        const ImageT = @TypeOf(@field(output, field.name));
        @field(output, field.name) = .{
            .data = try allocator.alloc(ImageT.Pixel, count * width),
            .width = width,
            .height = height,
            .offset = start * width,
        };
    }
    var instance = kernel.create(input, output, params);
    if (@hasDecl(@TypeOf(instance), "evaluateDependents")) {
        instance.evaluateDependents();
    }
    const end = start + count;
    instance.outputCoord[1] = start;
    while (instance.outputCoord[1] < end) : (instance.outputCoord[1] += 1) {
        instance.outputCoord[0] = 0;
        while (instance.outputCoord[0] < width) : (instance.outputCoord[0] += 1) {
            instance.evaluatePixel();
        }
    }
    return output;
}

const ColorSpace = enum { srgb, @"display-p3" };

pub fn Image(comptime T: type, comptime len: comptime_int, comptime writable: bool) type {
    return struct {
        pub const Pixel = @Vector(4, T);
        pub const FPixel = @Vector(len, f32);
        pub const channels = len;

        data: if (writable) []Pixel else []const Pixel,
        width: u32,
        height: u32,
        colorSpace: ColorSpace = .srgb,
        offset: usize = 0,

        fn constrain(v: anytype, min: f32, max: f32) @TypeOf(v) {
            const lower: @TypeOf(v) = @splat(min);
            const upper: @TypeOf(v) = @splat(max);
            const v2 = @select(f32, v > lower, v, lower);
            return @select(f32, v2 < upper, v2, upper);
        }

        fn pbPixelFromFloatPixel(pixel: Pixel) FPixel {
            if (len == 4) {
                return pixel;
            }
            const mask: @Vector(len, i32) = switch (len) {
                1 => .{0},
                2 => .{ 0, 3 },
                3 => .{ 0, 1, 2 },
                else => @compileError("Unsupported number of channels: " ++ len),
            };
            return @shuffle(f32, pixel, undefined, mask);
        }

        fn floatPixelFromPBPixel(pixel: FPixel) Pixel {
            if (len == 4) {
                return pixel;
            }
            const alpha: @Vector(1, T) = if (len == 1 or len == 3) .{1} else undefined;
            const mask: @Vector(len, i32) = switch (len) {
                1 => .{ 0, 0, 0, -1 },
                2 => .{ 0, 0, 0, 1 },
                3 => .{ 0, 1, 2, -1 },
                else => @compileError("Unsupported number of channels: " ++ len),
            };
            return @shuffle(T, pixel, alpha, mask);
        }

        fn pbPixelFromIntPixel(pixel: Pixel) FPixel {
            const numerator: FPixel = switch (@hasDecl(std.math, "fabs")) {
                // Zig 0.12.0
                false => switch (len) {
                    1 => @floatFromInt(@shuffle(T, pixel, undefined, @Vector(1, i32){0})),
                    2 => @floatFromInt(@shuffle(T, pixel, undefined, @Vector(2, i32){ 0, 3 })),
                    3 => @floatFromInt(@shuffle(T, pixel, undefined, @Vector(3, i32){ 0, 1, 2 })),
                    4 => @floatFromInt(pixel),
                    else => @compileError("Unsupported number of channels: " ++ len),
                },
                // Zig 0.11.0
                true => switch (len) {
                    1 => .{
                        @floatFromInt(pixel[0]),
                    },
                    2 => .{
                        @floatFromInt(pixel[0]),
                        @floatFromInt(pixel[3]),
                    },
                    3 => .{
                        @floatFromInt(pixel[0]),
                        @floatFromInt(pixel[1]),
                        @floatFromInt(pixel[2]),
                    },
                    4 => .{
                        @floatFromInt(pixel[0]),
                        @floatFromInt(pixel[1]),
                        @floatFromInt(pixel[2]),
                        @floatFromInt(pixel[3]),
                    },
                    else => @compileError("Unsupported number of channels: " ++ len),
                },
            };
            const denominator: FPixel = @splat(@floatFromInt(std.math.maxInt(T)));
            return numerator / denominator;
        }

        fn intPixelFromPBPixel(pixel: FPixel) Pixel {
            const max: f32 = @floatFromInt(std.math.maxInt(T));
            const multiplier: FPixel = @splat(max);
            const product: FPixel = constrain(pixel * multiplier, 0, max);
            const maxAlpha: @Vector(1, f32) = .{std.math.maxInt(T)};
            return switch (@hasDecl(std.math, "fabs")) {
                // Zig 0.12.0
                false => switch (len) {
                    1 => @intFromFloat(@shuffle(f32, product, maxAlpha, @Vector(4, i32){ 0, 0, 0, -1 })),
                    2 => @intFromFloat(@shuffle(f32, product, undefined, @Vector(4, i32){ 0, 0, 0, 1 })),
                    3 => @intFromFloat(@shuffle(f32, product, maxAlpha, @Vector(4, i32){ 0, 1, 2, -1 })),
                    4 => @intFromFloat(product),
                    else => @compileError("Unsupported number of channels: " ++ len),
                },
                // Zig 0.11.0
                true => switch (len) {
                    1 => .{
                        @intFromFloat(product[0]),
                        @intFromFloat(product[0]),
                        @intFromFloat(product[0]),
                        maxAlpha[0],
                    },
                    2 => .{
                        @intFromFloat(product[0]),
                        @intFromFloat(product[0]),
                        @intFromFloat(product[0]),
                        @intFromFloat(product[1]),
                    },
                    3 => .{
                        @intFromFloat(product[0]),
                        @intFromFloat(product[1]),
                        @intFromFloat(product[2]),
                        maxAlpha[0],
                    },
                    4 => .{
                        @intFromFloat(product[0]),
                        @intFromFloat(product[1]),
                        @intFromFloat(product[2]),
                        @intFromFloat(product[3]),
                    },
                    else => @compileError("Unsupported number of channels: " ++ len),
                },
            };
        }

        fn getPixel(self: @This(), x: u32, y: u32) FPixel {
            const index = (y * self.width) + x - self.offset;
            const src_pixel = self.data[index];
            const pixel: FPixel = switch (@typeInfo(T)) {
                .Float => pbPixelFromFloatPixel(src_pixel),
                .Int => pbPixelFromIntPixel(src_pixel),
                else => @compileError("Unsupported type: " ++ @typeName(T)),
            };
            return pixel;
        }

        fn setPixel(self: @This(), x: u32, y: u32, pixel: FPixel) void {
            if (comptime !writable) {
                return;
            }
            const index = (y * self.width) + x - self.offset;
            const dst_pixel: Pixel = switch (@typeInfo(T)) {
                .Float => floatPixelFromPBPixel(pixel),
                .Int => intPixelFromPBPixel(pixel),
                else => @compileError("Unsupported type: " ++ @typeName(T)),
            };
            self.data[index] = dst_pixel;
        }

        fn pixelSize(self: @This()) @Vector(2, f32) {
            _ = self;
            return .{ 1, 1 };
        }

        fn pixelAspectRatio(self: @This()) f32 {
            _ = self;
            return 1;
        }

        inline fn getPixelAt(self: @This(), coord: @Vector(2, f32)) FPixel {
            const left_top: @Vector(2, f32) = .{ 0, 0 };
            const bottom_right: @Vector(2, f32) = .{ @floatFromInt(self.width), @floatFromInt(self.height) };
            if (@reduce(.And, coord >= left_top) and @reduce(.And, coord < bottom_right)) {
                const ic: @Vector(2, u32) = switch (@hasDecl(std.math, "fabs")) {
                    // Zig 0.12.0
                    false => @intFromFloat(coord),
                    // Zig 0.11.0
                    true => .{ @intFromFloat(coord[0]), @intFromFloat(coord[0]) },
                };
                return self.getPixel(ic[0], ic[1]);
            } else {
                return @splat(0);
            }
        }

        fn sampleNearest(self: @This(), coord: @Vector(2, f32)) FPixel {
            return self.getPixelAt(coord);
        }

        fn sampleLinear(self: @This(), coord: @Vector(2, f32)) FPixel {
            const c = coord - @as(@Vector(2, f32), @splat(0.5));
            const c0 = @floor(c);
            const f0 = c - c0;
            const f1 = @as(@Vector(2, f32), @splat(1)) - f0;
            const w: @Vector(4, f32) = .{
                f1[0] * f1[1],
                f0[0] * f1[1],
                f1[0] * f0[1],
                f0[0] * f0[1],
            };
            const p00 = self.getPixelAt(c0);
            const p01 = self.getPixelAt(c0 + @as(@Vector(2, f32), .{ 0, 1 }));
            const p10 = self.getPixelAt(c0 + @as(@Vector(2, f32), .{ 1, 0 }));
            const p11 = self.getPixelAt(c0 + @as(@Vector(2, f32), .{ 1, 1 }));
            var result: FPixel = undefined;
            comptime var i = 0;
            inline while (i < len) : (i += 1) {
                const p: @Vector(4, f32) = .{ p00[i], p10[i], p01[i], p11[i] };
                result[i] = @reduce(.Add, p * w);
            }
            return result;
        }
    };
}

pub fn KernelInput(comptime T: type, comptime Kernel: type) type {
    const input_fields = std.meta.fields(@TypeOf(Kernel.inputImages));
    comptime var struct_fields: [input_fields.len]std.builtin.Type.StructField = undefined;
    inline for (input_fields, 0..) |field, index| {
        const input = @field(Kernel.inputImages, field.name);
        const ImageT = Image(T, input.channels, false);
        const default_value: ImageT = undefined;
        struct_fields[index] = .{
            .name = field.name,
            .type = ImageT,
            .default_value = @ptrCast(&default_value),
            .is_comptime = false,
            .alignment = @alignOf(ImageT),
        };
    }
    return @Type(.{
        .Struct = .{
            .layout = enum_auto,
            .fields = &struct_fields,
            .decls = &.{},
            .is_tuple = false,
        },
    });
}

pub fn KernelOutput(comptime T: type, comptime Kernel: type) type {
    const output_fields = std.meta.fields(@TypeOf(Kernel.outputImages));
    comptime var struct_fields: [output_fields.len]std.builtin.Type.StructField = undefined;
    inline for (output_fields, 0..) |field, index| {
        const output = @field(Kernel.outputImages, field.name);
        const ImageT = Image(T, output.channels, true);
        const default_value: ImageT = undefined;
        struct_fields[index] = .{
            .name = field.name,
            .type = ImageT,
            .default_value = @ptrCast(&default_value),
            .is_comptime = false,
            .alignment = @alignOf(ImageT),
        };
    }
    return @Type(.{
        .Struct = .{
            .layout = enum_auto,
            .fields = &struct_fields,
            .decls = &.{},
            .is_tuple = false,
        },
    });
}

pub fn KernelParameters(comptime Kernel: type) type {
    const param_fields = std.meta.fields(@TypeOf(Kernel.parameters));
    comptime var struct_fields: [param_fields.len]std.builtin.Type.StructField = undefined;
    inline for (param_fields, 0..) |field, index| {
        const param = @field(Kernel.parameters, field.name);
        const default_value: ?*const anyopaque = get_def: {
            const value: param.type = if (@hasField(@TypeOf(param), "defaultValue"))
            param.defaultValue
            else switch (@typeInfo(param.type)) {
                .Int, .Float => 0,
                .Bool => false,
                .Vector => @splat(0),
                else => @compileError("Unrecognized parameter type: " ++ @typeName(param.type)),
            };
            break :get_def @ptrCast(&value);
        };
        struct_fields[index] = .{
            .name = field.name,
            .type = param.type,
            .default_value = default_value,
            .is_comptime = false,
            .alignment = @alignOf(param.type),
        };
    }
    return @Type(.{
        .Struct = .{
            .layout = enum_auto,
            .fields = &struct_fields,
            .decls = &.{},
            .is_tuple = false,
        },
    });
}
