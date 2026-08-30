#!/usr/bin/env python3
"""Alpha-compose two non-interlaced RGBA PNG screenshots using only stdlib."""
import sys, struct, zlib, binascii

def read_png(path):
    data=open(path,"rb").read(); offset=8; compressed=b""
    while offset<len(data):
        size=int.from_bytes(data[offset:offset+4],"big"); kind=data[offset+4:offset+8]; body=data[offset+8:offset+8+size]; offset+=12+size
        if kind==b"IHDR": width,height,depth,color,_,_,interlace=struct.unpack(">IIBBBBB",body)
        elif kind==b"IDAT": compressed+=body
        elif kind==b"IEND": break
    if depth!=8 or color!=6 or interlace!=0: raise ValueError(f"Expected RGBA8 PNG: {path}")
    raw=zlib.decompress(compressed); stride=width*4; rows=[]; previous=bytearray(stride); cursor=0
    for _ in range(height):
        filter_type=raw[cursor]; cursor+=1; row=bytearray(raw[cursor:cursor+stride]); cursor+=stride
        for index in range(stride):
            left=row[index-4] if index>=4 else 0; above=previous[index]; corner=previous[index-4] if index>=4 else 0
            if filter_type==1: row[index]=(row[index]+left)&255
            elif filter_type==2: row[index]=(row[index]+above)&255
            elif filter_type==3: row[index]=(row[index]+((left+above)//2))&255
            elif filter_type==4:
                value=left+above-corner; pa=abs(value-left); pb=abs(value-above); pc=abs(value-corner)
                row[index]=(row[index]+(left if pa<=pb and pa<=pc else above if pb<=pc else corner))&255
        rows.append(row); previous=row
    return width,height,rows

def chunk(kind,body): return struct.pack(">I",len(body))+kind+body+struct.pack(">I",binascii.crc32(kind+body)&0xffffffff)
def main(base_path,overlay_path,out_path):
    width,height,base=read_png(base_path); ow,oh,overlay=read_png(overlay_path)
    if (width,height)!=(ow,oh): raise ValueError("Screenshot layers differ in size")
    raw=bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            index=x*4; foreground=overlay[y][index:index+4]; background=base[y][index:index+4]
            alpha=foreground[3]/255; inverse=1-alpha
            raw.extend((round(foreground[i]*alpha+background[i]*inverse) for i in range(3))); raw.append(255)
    png=b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",width,height,8,6,0,0,0))+chunk(b"IDAT",zlib.compress(bytes(raw),9))+chunk(b"IEND",b"")
    open(out_path,"wb").write(png)
if __name__=="__main__": main(*sys.argv[1:])
