 //代码里只修改了两处，分别在87行和109行，调试时已经不会报错，但是场景空白，只有背景
function init() { 
  var stats = initStats();
  var scene = new THREE.Scene();
  var renderer = initRenderer();
  var camera = initCamera();
  var virtualCamera = initVirtualCamera();//用于覆盖域分析的虚拟视点相机，需要初始化位姿,大小根据实际情况确定
  //var helper = new THREE.CameraHelper( virtualCamera );
  //scene.add( helper );
 // alert(window.innerWidth+","+window.innerHeight);
  var clock = new THREE.Clock();
  //var tatget=new THREE.WebGLRendererTarget(2048,2048);//离屏渲染的宽高如果与实际渲染时不同是否有影响？
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
				 coord.xyz /= w; //透视除法，归一化
				 float vDepth = texture2D(vDepthTexture, coord.xy).r;//采样该像素映射到的虚拟相机深度图。可以这么理解：同一个空间点，用不同相机拍摄，投影到不同像素位置，tMatrix建立了这种映射关系
				 float zThreshold = 0.0005;//深度比较误差阈值，可以根据情况调整
				 float alpha = 0.5;//把覆盖域颜色和地下的三维模型颜色混合的系数
				 if( coord.z <= vDepth + zThreshold ) //判断遮挡关系
					gl_FragColor.xyz = gl_FragColor.xyz * alpha + vec3(0.0,1.0,0.0) * ( 1.0 - alpha ) ;//混合
        else
          gl_FragColor.xyz = gl_FragColor.xyz * alpha + vec3(1.0,0.0,0.0) * ( 1.0 - alpha ) ;//混合
			}	
		}
		`;
		
  VisibilityPass = function( scene, renderer, mainCamera, virtualCamera ){ //可见性Pass
	
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

		this.real_scene = scene;
		
		this.renderer = renderer;
		
		this.mainCamera = mainCamera; //主相机
		
		this.virtualCamera = virtualCamera;	//虚拟相机	
		
		this.updateVirtualCameraMatrix(); //更新虚拟相机矩阵，只要虚拟相机不变化，该矩阵不会修改，一次性做完，起优化作用
		
		this.renderTargetDepth = setupRenderTarget( virtualCamera.width, virtualCamera.height );//用于产生虚拟相机深度图
		
 		this.uniforms.vDepthTexture.value = this.renderTargetDepth.depthTexture;//将虚拟相机深度图与着色器绑定  

		this.buildDepthMap();////产生虚拟相机深度图
		
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
		//this.renderer.setRenderTarget( this.renderTargetDepth );
		
		//清除缓冲区
		//this.renderer.clear( );
		this.renderer.render( this.real_scene, this.virtualCamera, this.renderTargetDepth , true );
    
	}
 
});

  
  
  var renderPass = new THREE.RenderPass(scene, camera);

  //var customGrayScale = new THREE.ShaderPass(THREE.CustomGrayScaleShader);
  
  var visibilityPass = new VisibilityPass( scene, renderer, camera, virtualCamera);//可见性分析Pass
   visibilityPass.renderToScreen = true;
   
   //var effectCopy = new THREE.ShaderPass(THREE.CopyShader);
   //effectCopy.renderToScreen = true;
   //effectCopy.needsSwap = false;
  
  let targetWithDepth = setupRenderTarget( window.innerWidth , window.innerHeight);//产生一个带颜色纹理和深度纹理的FBO
  
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
    this.x = -44;
    this.y = 53;
    this.z = -119;
    this.fov=60;
    this.near=5;
    this.far=200;
    this.lax=0;
    this.lay=0;
    this.laz=0;
  }
  var gui = new dat.GUI();
  var folder1 = gui.addFolder("VirtualCamera");
  folder1.add(controls, 'x', -200, 200);
  folder1.add(controls, 'y', -200, 200);
  folder1.add(controls, 'z', -200, 200);
  folder1.add(controls, 'fov', 0, 180);
  folder1.add(controls, 'far', 5, 10000);
  folder1.add(controls, 'lax', 0, 1000);
  folder1.add(controls, 'lay', 0, 1000);
  folder1.add(controls, 'laz', 0, 1000);
  var loader = new THREE.GLTFLoader();
  loader.load("assets/city.gltf", function (gltf) {
    scene.add(gltf.scene);
	visibilityPass.buildDepthMap();// = true;
  });
  var helper = new THREE.CameraHelper( virtualCamera );
  scene.add(helper);
  render();
  function render() {
    stats.update();
    var delta = clock.getDelta();
    trackballControls.update(delta);
    //directionalLight.position.set(controls.x, controls.y, controls.z);
    virtualCamera.position.set(controls.x, controls.y, controls.z);
    virtualCamera.lookAt(controls.lax, controls.lay, controls.laz);
    virtualCamera.fov=controls.fov;
    virtualCamera.far=controls.far;
    virtualCamera.updateProjectionMatrix();
    helper.update();
    visibilityPass.updateVirtualCameraMatrix();
    visibilityPass.buildDepthMap();
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

function initCamera(initialPosition) {                                                             //初始化相机
  var position = (initialPosition !== undefined) ? initialPosition : new THREE.Vector3(-30, 40, 30);

  var camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight,5,1000);
  camera.position.copy(position);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  camera.updateMatrix();
  camera.width = window.innerWidth;
  camera.height = window.innerHeight;
  return camera;
}

function initVirtualCamera(initialPosition) {                                                             //初始化相机
  var position = (initialPosition !== undefined) ? initialPosition : new THREE.Vector3(-30, 150, 30);//new THREE.Vector3(-150, 40, 30);

  var camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight,5, 1000);
  camera.position.copy(position);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  camera.updateMatrix();
  camera.width =window.innerWidth;
  camera.height =window.innerHeight;
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

