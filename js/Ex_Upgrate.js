 //代码里只修改了两处，分别在87行和109行，调试时已经不会报错，但是场景空白，只有背景
 //3.0计划
 //1、解决遮挡问题，实现正确效果；解决视图主Camera变化后可视域渲染改变的问题:深度比较环节有问题
 //2、实现利用界面GUI控制虚拟相机参数，包括位置、视线等
function init() { 
  var stats = initStats();
  var scene = new THREE.Scene();
  var renderer = initRenderer();
  var camera = initCamera();
  var virtualCamera = initVirtualCamera();//用于覆盖域分析的虚拟视点相机，需要初始化位姿
  var helper = new THREE.CameraHelper( virtualCamera );
  scene.add( helper );
  var clock = new THREE.Clock();
	const vs=
	`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); 
		}
		`;
		
	const fs=`
		uniform sampler2D tDiffuse; //renderpass的输出作为背景图                                                               
		uniform sampler2D depthTexture; //renderpass输出的深度图                                                           
		uniform sampler2D vDepthTexture;//虚拟相机的深度图
		uniform mat4 tMatrix;//变换矩阵，用于从背景图像素变换到虚拟相机空间	
		varying vec2 vUv;                                                                        

		void main() {              

			gl_FragColor = texture2D(tDiffuse, vUv.xy);//背景图像素

			float mainDepth = texture2D(depthTexture, vUv).r;//背景图像素对应的深度
			
			if( mainDepth == 1.0 ) return; //1.0 表示远平面，不用于测试
			
			vec4 coord = vec4(vUv.x,vUv.y,mainDepth,1.0);//屏幕像素对应的齐次坐标
			coord = tMatrix * coord;//屏幕像素变换到虚拟相机空间			
			float w = coord.w ;
			if( w > 0.0 && coord.x > 0.0 && coord.x < w && coord.y < w && coord.y > 0.0 && coord.z <= w && coord.z >= 0.0 ) //判断该像素是否可见
			{
				 coord.xy /= w; //透视除法，归一化
				 float vDepth = texture2D(vDepthTexture, coord.xy).r;//采样该像素映射到的虚拟相机深度图。可以这么理解：同一个空间点，用不同相机拍摄，在不同像素位置，tMatrix建立了这种映射关系
				 
				 float zThreshold = 0.05;//深度比较误差阈值，可以根据情况调整
				 float alpha = 0.5;//把覆盖域颜色和地下的三维模型颜色混合的系数
				// if( coord.z <= vDepth + zThreshold ) //判断遮挡关系
					gl_FragColor.xyz = gl_FragColor.xyz * alpha + vec3(1.0,0.0,0.0) * ( 1.0 - alpha ) ;//混合
			}	
		}
		`;
		
  VisibilityPass = function( scene, renderer, mainCamera, virtualCamera ){ //可见性Pass
   		this.scene = scene;
		
		this.renderer = renderer;
		
		this.mainCamera = mainCamera; //主相机
		
		this.virtualCamera = virtualCamera;	//虚拟相机	
		
		this.updateVirtualCameraMatrix(); //更新虚拟相机矩阵，只要虚拟相机不变化，该矩阵不会修改，一次性做完，起优化作用
		
		this.renderTargetDepth = setupRenderTarget( virtualCamera.width, virtualCamera.height );//用于产生虚拟相机深度图
		
		this.buildDepthMap();////产生虚拟相机深度图
		
		
		THREE.ShaderPass.call( this,  {
					uniforms: {
						tDiffuse: { value: null },
						depthTexture:{value:null},
						vDepthTexture:{value:null},
						tMatrix:{value:null},
					},

					vertexShader: vs,
					fragmentShader: fs
				} 
			);

			
			
 		this.uniforms.vDepthTexture.value = this.renderTargetDepth.depthTexture;//将虚拟相机深度图与着色器绑定  

	}

	VisibilityPass.prototype = Object.assign( Object.create( THREE.ShaderPass.prototype ), {

	constructor: VisibilityPass,
	
	render :function( renderer, writeBuffer, readBuffer, deltaTime, maskActive ) {	
		
 		this.uniforms.depthTexture.value = readBuffer.depthTexture;//将主相机深度图与着色器绑定
		
		let tMatrix =new THREE.Matrix4();//主相机屏幕空间到虚拟相机屏幕空间的变换矩阵，主相机屏幕空间-》主相机投影空间-》世界空间-》虚拟相机投影空间-》虚拟相机屏幕空间
		
		tMatrix.multiply( this.vpMatrix ); //变换到虚拟相机空间
					
		tMatrix.multiply( this.mainCamera.matrixWorld); //主相机逆视图矩阵
    //tMatrix.multiply( this.mainCamera.projectionMatrixInverse); //主视点逆投影矩阵
		//这里也报了语法错误，应该是.projectionMatrixInverse属性这里不能直接用，用个新矩阵中转一下就不报错了，原因我也不太清楚		
    let projectionMatrixInverse=new THREE.Matrix4();
    projectionMatrixInverse.getInverse(this.mainCamera.projectionMatrix);
    tMatrix.multiply(projectionMatrixInverse);
    
		let v = new THREE.Matrix4(); //将主相机像素坐标从 [0,1] 变换为 [-1,1],因为规范化的齐次空间坐标为 [-1，+1]
		v.set(	2.0,0.0,0.0,-1.0,
				0.0,2.0,0.0,-1.0,
				0.0,0.0,2.0,-1.0,
				0.0,0.0,0.0,1.0);
				
		tMatrix.multiply(v);

		this.uniforms.tMatrix.value = tMatrix;	//将主相机到虚拟相机的变换矩阵和着色器关联	 
		
		VisibilityPass.prototype.__proto__.render.call( this, renderer, writeBuffer, readBuffer, deltaTime, maskActive );
	},	

	updateVirtualCameraMatrix :function(){ //更新虚拟相机矩阵，只要虚拟相机不变化，该矩阵不会修改，因此只需要在必要的时候调用
	
		let virtualCameraViewMatrix  = new THREE.Matrix4();//视图矩阵和模型变换矩阵互为逆阵
		//virtualCameraViewMatrix.copy( this.virtualCamera.matrix ).invert();
		virtualCameraViewMatrix.getInverse(this.virtualCamera.matrix );//调试时前面的invert函数报语法错误，所以这里改了一下
		this.vpMatrix = new THREE.Matrix4();//
		this.vpMatrix.set(	0.5,0.0,0.0,0.5,
			0.0,0.5,0.0,0.5,
			0.0,0.0,0.5,0.5,
			0.0,0.0,0.0,1.0);

		this.vpMatrix.multiply( this.virtualCamera.projectionMatrix);
		this.vpMatrix.multiply( virtualCameraViewMatrix);
	},
	
	buildDepthMap : function( ){ //产生虚拟相机深度图
		this.renderer.setRenderTarget( this.renderTargetDepth );
		
		//清除缓冲区
		this.renderer.clear( );
		this.renderer.render( this.scene, this.virtualCamera);
		
	}
});

  

  var renderPass = new THREE.RenderPass(scene, camera);

  //var customGrayScale = new THREE.ShaderPass(THREE.CustomGrayScaleShader);
  
  var visibilityPass = new VisibilityPass( scene, renderer, camera, virtualCamera);//可见性分析Pass
   visibilityPass.renderToScreen = true;
   
   //var effectCopy = new THREE.ShaderPass(THREE.CopyShader);
   //effectCopy.renderToScreen = true;
   //effectCopy.needsSwap = false;
  
  let targetWithDepth = setupRenderTarget( window.innerWidth , window.innerHeight );//产生一个带颜色纹理和深度纹理的FBO
  
  var composer = new THREE.EffectComposer(renderer ,targetWithDepth );//把带颜色纹理和深度纹理的FBO传入，否则，内部产生的FBO不会带深度纹理
  
  composer.addPass(renderPass);
  composer.addPass(visibilityPass);
  
  //composer.addPass(effectCopy);
  // camera.position.set(-60,150,30);
  // camera.lookAt(new THREE.Vector3(0, 0, 0));
  //composer.addPass(effectCopy);
  var directionalLight = initDefaultLighting(scene);  //初始化光源
  var trackballControls = initTrackballControls(camera, renderer);
  
  var controls = new function () {
    this.x = -60;
    this.y = 150;
    this.z = -30;
    this.Cx = -150;
    this.Cy = 40;
    this.Cz = 30;
  }
  var gui = new dat.GUI();
  var folder1 = gui.addFolder("LightPosition");
  folder1.add(controls, 'x', -200, 200);
  folder1.add(controls, 'y', -200, 200);
  folder1.add(controls, 'z', -200, 200);
  var folder2 = gui.addFolder("virtualCameraPosition");
  folder2.add(controls, 'Cx', -200, 200);
  folder2.add(controls, 'Cy', -200, 200);
  folder2.add(controls, 'Cz', -200, 200);
  var loader = new THREE.OBJLoader();
  loader.load("assets/city.obj", function (object) {
    var scale = chroma.scale(['red', 'green', 'blue']);
    setRandomColors(object, scale);
    mesh = object;
    scene.add(mesh);
  });
  
  render();
  function render() {
    stats.update();
    var delta = clock.getDelta();
    trackballControls.update(delta);
    directionalLight.position.set(controls.x, controls.y, controls.z);
    virtualCamera.position.set(controls.Cx, controls.Cy, controls.Cz);
	  composer.render(delta);
    requestAnimationFrame(render);  
  }
}

function setupRenderTarget( width, height ) {//产生一个带颜色纹理和深度纹理的FBO

	let target = new THREE.WebGLRenderTarget( width , height );

	target.texture.minFilter = THREE.NearestFilter;
	target.texture.magFilter = THREE.NearestFilter;
	target.texture.generateMipmaps = false;
	target.texture.format = THREE.RGBAFormat;
	
	target.depthBuffer = true;
	target.depthTexture = new THREE.DepthTexture(); 
	
	return target;
}
	
function initStats(type) {

  var panelType = (typeof type !== 'undefined' && type) && (!isNaN(type)) ? parseInt(type) : 0;
  var stats = new Stats();

  stats.showPanel(panelType); // 0: fps, 1: ms, 2: mb, 3+: custom
  document.body.appendChild(stats.dom);

  return stats;
}

function initRenderer(additionalProperties) {                                                    //初始化渲染器

  var props = (typeof additionalProperties !== 'undefined' && additionalProperties) ? additionalProperties : {};
  var renderer = new THREE.WebGLRenderer(props);
  // renderer.shadowMap.enabled = true;
  // renderer.shadowMap.type=THREE.BasicShadowMap;
  //renderer.shadowMapSoft = true;

  renderer.setClearColor(new THREE.Color(0xf0f8ff));
  renderer.setSize(window.innerWidth, window.innerHeight);
  //renderer.shadowMap.enabled = true;
  document.getElementById("webgl-output").appendChild(renderer.domElement);

  return renderer;
}

function initCamera(initialPosition) {      //初始化相机
  var position = (initialPosition !== undefined) ? initialPosition : new THREE.Vector3(-30, 40, 30);

  var camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight,10,1000);
  camera.position.copy(position);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  camera.updateMatrix();
  camera.width = window.innerWidth;
  camera.height = window.innerHeight;
  return camera;
  
}

function initVirtualCamera(initialPosition) {                                                             //初始化相机
  var position = (initialPosition !== undefined) ? initialPosition : new THREE.Vector3(-150, 40, 30);
   
  var camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight,3, 500);
  camera.position.copy(position);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  camera.updateMatrix();
  camera.width = window.innerWidth;
  camera.height = window.innerHeight;
  return camera;
}

function initDefaultLighting(scene) {                                               //初始化光源
  var directionalLight = new THREE.DirectionalLight(0xffffff);
  directionalLight.position.set(-40, 60, -10)
  directionalLight.castShadow = true;
  directionalLight.shadow.camera.near = 0;
  directionalLight.shadow.camera.far = 400;
  directionalLight.shadow.camera.left = -300;
  directionalLight.shadow.camera.right = 300;
  directionalLight.shadow.camera.top = 300;
  directionalLight.shadow.camera.bottom = -300;
  directionalLight.intensity = 0.2;
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;

  scene.add(directionalLight);

  var ambientLight = new THREE.AmbientLight(0xffffff);
  ambientLight.name = "ambientLight";
  scene.add(ambientLight);
  return directionalLight;
}
function initTrackballControls(camera, renderer) {
  var trackballControls = new THREE.TrackballControls(camera, renderer.domElement);
  trackballControls.rotateSpeed = 1.0;
  trackballControls.zoomSpeed = 1.0;
  trackballControls.panSpeed = 1.0;
  // trackballControls.noZoom = false;
  // trackballControls.noPan = false;
  // trackballControls.staticMoving = true;
  // trackballControls.dynamicDampingFactor = 0.3;
  // trackballControls.keys = [65, 83, 68];

  return trackballControls;
}

function setRandomColors(object, scale) {  //随机设置颜色和材质
  var children = object.children;          //获取children数组
  //如果当前模型有子元素，则遍历子元素
  if (children && children.length > 0) {
    children.forEach(function (e) {
      setRandomColors(e, scale)
    });
  } else {
    if (object instanceof THREE.Mesh) {//如果object是Mesh对象的实例
      object.castShadow = true;
      object.receiveShadow = true;
      if (object.material instanceof Array) {//如果当前的模型是楼层，则设置固定的颜色，并且透明化
        object.material.forEach(function (m) {
          if (m.name.indexOf("building") == 0) {
            m.color = new THREE.Color(0x6495ed);//scale(Math.random()).hex());
          }

          if (m.name.indexOf("post") == 0) {
            m.color = new THREE.Color(0xc0c0c0);//银色
          }
          if (m.name.indexOf("lamp") == 0) {
            m.color = new THREE.Color(0x000000);//黑色
          }
          if (m.name.indexOf("stop_light") == 0) {
            m.color = new THREE.Color(0x191970);//午夜蓝
          }

          if (m.name.indexOf("street") == 0) {
            m.color = new THREE.Color(0x000080);//海军蓝
          }

          if (m.name.indexOf("default") == 0) {
            m.color = new THREE.Color(0x7cfc00);//草坪绿
          }
          if (m.name.indexOf("ac") == 0) {
            m.color = new THREE.Color(0x704214);//深褐色
          }

          if (m.name.indexOf("pavement_2") == 0) {
            m.color = new THREE.Color(0x778899);//亮岩灰
          }
          if (m.name.indexOf("default") == 0) {
            m.color = new THREE.Color(0xc0c0c0);//银色
          }
        });
      } else {// 如果不是场景组，则给当前mesh添加纹理
        if (object.material.name.indexOf("freeway") == 0) {
          object.material.color = new THREE.Color(0x2f4f4f);//灰岩色
        }
        if (object.material.name.indexOf("post") == 0) {
          object.material.color = new THREE.Color(0x708090);//岩灰
        }
        if (object.material.name.indexOf("pavement_2") == 0) {
          object.material.color = new THREE.Color(0x778899);//亮岩灰
        }
        if (object.material.name.indexOf("pavement_1") == 0) {
          object.material.color = new THREE.Color(0xafdfe4);//岩灰0x778899);//亮岩灰
        }
        if (object.material.name.indexOf("default") == 0) {
          object.material.color = new THREE.Color(0xc0c0c0);//银色
        }
        if (object.material.name.indexOf("ac") == 0) {
          object.material.color = new THREE.Color(0x704214);//深褐色
        }
        //object.material.color = new THREE.Color(0xff7f50);//scale(Math.random()).hex());//hex返回一个数字的十六进制值，随机当前模型的颜色
        //alert(object.material.name);
        if (object.material.name.indexOf("building") == 0) {
          //object.material.emissive = new THREE.Color(0xff7f50);
          //object.material.transparent = true;
          object.material.opacity = 0.8;
        }
      }
    }
    //pavement_1 地面 、pavement_2楼边小路、ac_units楼顶小方块、freeway_1高架路、freeway_2高架路牌，post_1路灯杆和高架框、lamp_1灯泡、street_sign路灯牌、stop_light路灯下灯


    // no children assume contains a mesh
    /* if (object instanceof THREE.Mesh) {//如果object是Mesh对象的实例
       if (object.material instanceof Array) {//如果当前的模型是楼层，则设置固定的颜色，并且透明化
         object.material.forEach(function (m) {
           m.color = new THREE.Color(0x0d33ff);//;scale(Math.random()).hex())
           if (m.name.indexOf("building") == 0) {
             //m.emissive = new THREE.Color(0x0d33ff);
             //m.transparent = true;
             m.opacity = 0.8;
           }
         });
       } else {// 如果不是场景组，则给当前mesh添加纹理
         object.material.color = new THREE.Color(0xff7f50);//scale(Math.random()).hex());//hex返回一个数字的十六进制值，随机当前模型的颜色
         //alert(object.material.name);
         if (object.material.name.indexOf("building") == 0) {
           //object.material.emissive = new THREE.Color(0xff7f50);
           //object.material.transparent = true;
           object.material.opacity = 0.8;
         }
       }
     }*/
  }
}
