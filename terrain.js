/* mwmap R16 height fields. Rendering, navigation and collisions share this grid. */
(function(root){
'use strict';
class TerrainField {
  static get SEA_LEVEL(){return 0;}
  constructor(meta, buffer){
    this.meta=meta; this.n=meta.resolution;this.seaLevel=TerrainField.SEA_LEVEL;
    if(buffer.byteLength!==this.n*this.n*2) throw new Error('지형 데이터 크기 오류');
    const view=new DataView(buffer); this.heights=new Float32Array(this.n*this.n);
    for(let z=0;z<this.n;z++) for(let x=0;x<this.n;x++)
      this.heights[z*this.n+x]=meta.altMin+view.getUint16(((this.n-1-z)*this.n+x)*2,true)/65535*(meta.altMax-meta.altMin);
    // Eight-neighbour distance is a conservative clearance (square around land).
    this.clearance=new Float32Array(this.heights.length).fill(1e6);
    const queue=new Int32Array(this.heights.length); let head=0,tail=0;
    // Only exposed land blocks surface ships; shallow seabed is navigable.
    this.heights.forEach((h,i)=>{if(h>this.seaLevel){this.clearance[i]=0;queue[tail++]=i;}});
    while(head<tail){const i=queue[head++],x=i%this.n,z=Math.floor(i/this.n);
      for(let dz=-1;dz<=1;dz++) for(let dx=-1;dx<=1;dx++){
        const xx=x+dx,zz=z+dz,j=zz*this.n+xx;
        if(xx<0||zz<0||xx>=this.n||zz>=this.n||this.clearance[j]<=this.clearance[i]+1)continue;
        this.clearance[j]=this.clearance[i]+1;queue[tail++]=j;
      }
    }
    this.setScale(1);
  }
  setScale(scale){
    this.scale=scale;this.size=this.meta.worldSize*scale;this.cell=this.size/(this.n-1);this.x0=-this.size/2;this.z0=-this.size/2;
    this.boundary=(this.meta.playableBoundary?.points||[]).map(p=>({x:(p.x-this.meta.originX-this.meta.worldSize/2)*scale,z:(this.meta.originZ+this.meta.worldSize/2-p.z)*scale}));
  }
  withinBoundary(x,z,radius=0){
    if(this.boundary.length<3)return true;
    let inside=false,minDistance=Infinity;
    for(let i=0,j=this.boundary.length-1;i<this.boundary.length;j=i++){
      const a=this.boundary[j],b=this.boundary[i],dx=b.x-a.x,dz=b.z-a.z;
      if((a.z>z)!==(b.z>z)&&x<(b.x-a.x)*(z-a.z)/(b.z-a.z)+a.x)inside=!inside;
      const t=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/(dx*dx+dz*dz||1)));
      minDistance=Math.min(minDistance,Math.hypot(x-a.x-dx*t,z-a.z-dz*t));
    }
    return (inside||minDistance<1e-7)&&minDistance+1e-7>=radius;
  }
  nearWater(origin,radius){
    const min=Math.max(1000,radius+220),max=Math.max(3500,min+500);
    for(let i=0;i<800;i++){
      const angle=Math.random()*Math.PI*2,d=Math.sqrt(min*min+Math.random()*(max*max-min*min));
      const x=origin.x+Math.cos(angle)*d,z=origin.z+Math.sin(angle)*d;
      if(this.clear(x,z,radius))return {x,y:this.seaLevel,z};
    }
    // Deterministic local search avoids a distant or land-based fallback.
    const offset=Math.random()*Math.PI*2;
    for(let j=0;j<=20;j++)for(let i=0;i<128;i++){
      const d=min+(max-min)*j/20,angle=offset+i*Math.PI/64;
      const x=origin.x+Math.cos(angle)*d,z=origin.z+Math.sin(angle)*d;
      if(this.clear(x,z,radius))return {x,y:this.seaLevel,z};
    }
    return null;
  }
  spawn(radius){
    const all=(this.meta.spawns||[]).filter(s=>Number.isFinite(s.x)&&Number.isFinite(s.z));
    const standard=all.filter(s=>s.category==='standard');
    const points=(standard.length?standard:all).map(s=>({
      x:(s.x-this.meta.originX-this.meta.worldSize/2)*this.scale,
      z:(this.meta.originZ+this.meta.worldSize/2-s.z)*this.scale,
      heading:-(s.heading||0)*Math.PI/180,id:s.id,adjusted:false
    }));
    const safe=points.filter(p=>this.clear(p.x,p.z,radius));
    if(safe.length)return safe[Math.floor(Math.random()*safe.length)];
    if(!points.length)throw new Error('함선 스폰 위치가 없습니다');
    const selected=points[Math.floor(Math.random()*points.length)];
    // At very small scales a full-sized hull may not fit any original spawn.
    const step=Math.max(this.cell,radius/2);
    for(let r=step;r<this.size*2+radius*4;r+=step){
      for(let i=0;i<32;i++){
        const angle=i*Math.PI/16,x=selected.x+Math.cos(angle)*r,z=selected.z+Math.sin(angle)*r;
        if(this.clear(x,z,radius))return {...selected,x,z,adjusted:true};
      }
    }
    throw new Error('스폰 주변에 안전한 해역이 없습니다');
  }
  height(x,z){
    const gx=(x-this.x0)/this.cell,gz=(z-this.z0)/this.cell;
    if(gx<0||gz<0||gx>this.n-1||gz>this.n-1)return -Infinity;
    const ix=Math.min(this.n-2,Math.floor(gx)),iz=Math.min(this.n-2,Math.floor(gz)),u=gx-ix,v=gz-iz,i=iz*this.n+ix;
    const a=this.heights[i],b=this.heights[i+1],c=this.heights[i+this.n],d=this.heights[i+this.n+1];
    // Match PlaneGeometry's diagonal exactly.
    return (u+v<=1?a+(b-a)*u+(c-a)*v:d+(c-d)*(1-u)+(b-d)*(1-v))*this.scale;
  }
  broadClear(x,z,radius){
    const gx=(x-this.x0)/this.cell,gz=(z-this.z0)/this.cell;
    const ix=Math.max(0,Math.min(this.n-1,Math.round(gx))),iz=Math.max(0,Math.min(this.n-1,Math.round(gz)));
    const outside=Math.max(Math.abs(gx-ix),Math.abs(gz-iz));
    return (Math.max(outside,this.clearance[iz*this.n+ix])-2)*this.cell>radius;
  }
  clear(x,z,radius){
    if(!this.withinBoundary(x,z,radius))return false;
    if(this.broadClear(x,z,radius))return true;
    if(this.height(x,z)>this.seaLevel)return false;
    if(radius===0)return this.height(x,z)<=this.seaLevel;
    const r=radius/Math.cos(Math.PI/16),polygon=[];
    for(let i=0;i<16;i++){const a=i*Math.PI/8;polygon.push({x:x+Math.cos(a)*r,z:z+Math.sin(a)*r});}
    return this.polygonClear(polygon);
  }
  hullClear(x,z,heading,len){
    if(this.withinBoundary(x,z,len*.61)&&this.broadClear(x,z,len*.61))return true;
    if(this.height(x,z)>this.seaLevel)return false;
    const c=Math.cos(heading),s=Math.sin(heading);
    return this.polygonClear([[-.065,.41],[-.065,-.41],[0,-.59],[.065,-.41],[.065,.41]].map(([a,b])=>({x:x+(a*c+b*s)*len,z:z+(-a*s+b*c)*len})));
  }
  polygonClear(hull){
    if(hull.some(p=>!this.withinBoundary(p.x,p.z)))return false;
    // A concave boundary can cut through an edge even when both ends are inside.
    const cross=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
    for(let i=0;i<hull.length;i++)for(let j=0;j<this.boundary.length;j++){
      const a=hull[i],b=hull[(i+1)%hull.length],c=this.boundary[j],d=this.boundary[(j+1)%this.boundary.length];
      if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)return false;
    }
    // Clip each rendered terrain triangle to the actual footprint. An overlap
    // blocks only if its interpolated altitude is above the visible water plane.
    const minX=Math.min(...hull.map(p=>p.x)),maxX=Math.max(...hull.map(p=>p.x));
    const minZ=Math.min(...hull.map(p=>p.z)),maxZ=Math.max(...hull.map(p=>p.z));
    const x0=Math.max(0,Math.floor((minX-this.x0)/this.cell)),x1=Math.min(this.n-2,Math.floor((maxX-this.x0)/this.cell));
    const z0=Math.max(0,Math.floor((minZ-this.z0)/this.cell)),z1=Math.min(this.n-2,Math.floor((maxZ-this.z0)/this.cell));
    for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++){
      const index=z*this.n+x;
      if(Math.max(this.heights[index],this.heights[index+1],this.heights[index+this.n],this.heights[index+this.n+1])*this.scale<=this.seaLevel)continue;
      const point=(dx,dz)=>({x:this.x0+(x+dx)*this.cell,z:this.z0+(z+dz)*this.cell,h:this.heights[(z+dz)*this.n+x+dx]*this.scale});
      const a=point(0,0),b=point(1,0),c=point(0,1),d=point(1,1);
      for(const tri of [[a,b,c],[b,d,c]]){
        if(tri.every(p=>p.h<=this.seaLevel))continue;
        let poly=tri;
        for(let i=0;i<hull.length&&poly.length;i++){
          const u=hull[i],v=hull[(i+1)%hull.length],side=p=>(v.x-u.x)*(p.z-u.z)-(v.z-u.z)*(p.x-u.x),out=[];
          let prev=poly[poly.length-1],dp=side(prev);
          for(const p of poly){const dist=side(p);
            if((dist>=0)!==(dp>=0)){const t=dp/(dp-dist);out.push({x:prev.x+(p.x-prev.x)*t,z:prev.z+(p.z-prev.z)*t,h:prev.h+(p.h-prev.h)*t});}
            if(dist>=0)out.push(p);prev=p;dp=dist;
          }poly=out;
        }
        if(poly.some(p=>p.h>this.seaLevel+1e-7))return false;
      }
    }
    return true;
  }
  impact(a,b){
    // Split at every grid and triangle edge: height is linear in each interval.
    const dx=b.x-a.x,dz=b.z-a.z,dy=b.y-a.y;
    let lo=0,hi=1;
    for(const [p,d,min] of [[a.x,dx,this.x0],[a.z,dz,this.z0]]){
      if(Math.abs(d)<1e-12){if(p<min||p>min+this.size)return null;continue;}
      let t0=(min-p)/d,t1=(min+this.size-p)/d;if(t0>t1)[t0,t1]=[t1,t0];
      lo=Math.max(lo,t0);hi=Math.min(hi,t1);
    }
    if(lo>hi)return null;
    const cuts=[lo,hi];
    for(const [p,d,origin] of [[a.x,dx,this.x0],[a.z,dz,this.z0],[a.x+a.z,dx+dz,this.x0+this.z0]]){
      if(Math.abs(d)<1e-12)continue;
      const u=(p+d*lo-origin)/this.cell,v=(p+d*hi-origin)/this.cell;
      for(let k=Math.ceil(Math.min(u,v));k<=Math.floor(Math.max(u,v));k++){
        const t=(origin+k*this.cell-p)/d;if(t>lo&&t<hi)cuts.push(t);
      }
    }
    cuts.sort((a,b)=>a-b);
    const gap=t=>a.y+dy*t-this.height(Math.max(this.x0,Math.min(this.x0+this.size,a.x+dx*t)),Math.max(this.z0,Math.min(this.z0+this.size,a.z+dz*t)));
    let prev=cuts[0],g=gap(prev);
    if(g<=0)return {x:a.x+dx*prev,y:a.y+dy*prev,z:a.z+dz*prev,t:prev};
    for(let i=1;i<cuts.length;i++){
      const end=cuts[i],next=gap(end);
      if(next<=0){const t=prev+(end-prev)*g/(g-next);return {x:a.x+dx*t,y:a.y+dy*t,z:a.z+dz*t,t};}
      prev=end;g=next;
    }
    return null;
  }
  segmentClear(a,b,radius){
    const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/Math.max(1,this.cell/2)));
    for(let i=0;i<=steps;i++){const t=i/steps;if(!this.clear(a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t,radius))return false;}return true;
  }
  route(start,radius){
    const n=80,margin=Math.max(1000,radius*3),size=this.size+margin*2,cell=size/(n-1),origin=-size/2;
    const point=i=>({x:origin+(i%n)*cell,z:origin+Math.floor(i/n)*cell});
    const sx=Math.max(0,Math.min(n-1,Math.round((start.x-origin)/cell))),sz=Math.max(0,Math.min(n-1,Math.round((start.z-origin)/cell)));
    let first=-1,best=Infinity;
    for(let dz=-2;dz<=2;dz++)for(let dx=-2;dx<=2;dx++){
      const x=sx+dx,z=sz+dz;if(x<0||z<0||x>=n||z>=n)continue;
      const i=z*n+x,p=point(i),d=Math.hypot(p.x-start.x,p.z-start.z);
      if(d<best&&this.segmentClear(start,p,radius)){first=i;best=d;}
    }
    if(first<0)return [];
    const parents=new Int32Array(n*n).fill(-1),queue=new Int32Array(n*n);let head=0,tail=1;queue[0]=first;parents[first]=first;
    while(head<tail){const i=queue[head++],x=i%n,z=Math.floor(i/n);
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,zz=z+dz,j=zz*n+xx;
        if(xx<0||zz<0||xx>=n||zz>=n||parents[j]>=0)continue;
        if(!this.segmentClear(point(i),point(j),radius))continue;
        parents[j]=i;queue[tail++]=j;
      }
    }
    if(tail<2)return [];
    let end=queue[1+Math.floor(Math.random()*(tail-1))];const path=[];
    while(end!==first){path.push(point(end));end=parents[end];}path.push(point(first));return path.reverse();
  }
}
root.TerrainField=TerrainField;
if(typeof module!=='undefined')module.exports=TerrainField;
})(globalThis);
